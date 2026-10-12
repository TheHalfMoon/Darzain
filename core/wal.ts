// Read-only inspection of a SQLite write-ahead log (file format:
// https://www.sqlite.org/fileformat.html#the_write_ahead_log). SQLite reads
// frames from the start and stops, silently, at the first frame whose
// salts or cumulative checksum do not match; committed transactions after
// a damaged frame are then lost without an error, and the log is deleted
// at the next checkpoint. This finds that case before anything opens it.
//
// A crash may tear only the last frame written, so a single unreadable
// frame at the end of the log is normal. Frames of the current log
// generation (the header's salts) found after an unreadable frame are not:
// they are written transactions SQLite will skip. Frames with other salts
// are left from before a log restart and are ignored, as SQLite does.
// Limitation: damage confined to the final frame is indistinguishable from
// a torn write and is not reported.
import { open } from "node:fs/promises";

export type WalReport = {
  bytes: number;
  pageSize: number | null;
  headerValid: boolean;
  validFrames: number;
  validCommits: number;
  // Current-generation frames after the first unreadable one.
  unreadableFrames: number;
  lostCommits: number;
  damaged: boolean;
};

const MAGIC_LE = 0x377f0682;
const MAGIC_BE = 0x377f0683;

// SQLite's WAL checksum over 32-bit words in the log's byte order.
function checksum(
  data: Buffer,
  bigEndian: boolean,
  seed: [number, number],
): [number, number] {
  let [s0, s1] = seed;
  for (let i = 0; i + 8 <= data.length; i += 8) {
    const x0 = bigEndian ? data.readUInt32BE(i) : data.readUInt32LE(i);
    const x1 = bigEndian ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

export async function inspectWal(file: string): Promise<WalReport | null> {
  const handle = await open(file, "r").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!handle) return null;
  try {
    const bytes = (await handle.stat()).size;
    const report: WalReport = {
      bytes,
      pageSize: null,
      headerValid: false,
      validFrames: 0,
      validCommits: 0,
      unreadableFrames: 0,
      lostCommits: 0,
      damaged: false,
    };
    // An empty or header-only log holds no transactions.
    if (bytes < 32) {
      report.headerValid = bytes === 0;
      return report;
    }
    const header = Buffer.alloc(32);
    await handle.read(header, 0, 32, 0);
    const magic = header.readUInt32BE(0);
    const pageSize = header.readUInt32BE(8);
    const validSize =
      pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
    const bigEndian = magic === MAGIC_BE;
    if ((magic !== MAGIC_LE && magic !== MAGIC_BE) || !validSize) {
      // SQLite ignores the whole log; any frames in it are lost.
      report.damaged = bytes > 32;
      return report;
    }
    let seed = checksum(header.subarray(0, 24), bigEndian, [0, 0]);
    if (
      seed[0] !== header.readUInt32BE(24) ||
      seed[1] !== header.readUInt32BE(28)
    ) {
      report.damaged = bytes > 32;
      return report;
    }
    report.headerValid = true;
    report.pageSize = pageSize;
    const salt1 = header.readUInt32BE(16);
    const salt2 = header.readUInt32BE(20);
    const frameBytes = 24 + pageSize;
    const frame = Buffer.alloc(frameBytes);
    let broken = false;
    let unreadable = 0;
    for (let offset = 32; offset + frameBytes <= bytes; offset += frameBytes) {
      await handle.read(frame, 0, frameBytes, offset);
      const current =
        frame.readUInt32BE(8) === salt1 && frame.readUInt32BE(12) === salt2;
      const commit = frame.readUInt32BE(4) !== 0;
      if (!broken) {
        let next = checksum(frame.subarray(0, 8), bigEndian, seed);
        next = checksum(frame.subarray(24), bigEndian, next);
        if (
          current &&
          next[0] === frame.readUInt32BE(16) &&
          next[1] === frame.readUInt32BE(20)
        ) {
          seed = next;
          report.validFrames++;
          if (commit) report.validCommits++;
          continue;
        }
        broken = true;
        // The first unreadable frame may be a torn final write.
        if (current) unreadable++;
        continue;
      }
      if (current) {
        unreadable++;
        report.unreadableFrames++;
        if (commit) report.lostCommits++;
      }
    }
    // Damage: current-generation frames after the first unreadable frame.
    if (report.unreadableFrames > 0) report.unreadableFrames = unreadable;
    report.damaged = report.unreadableFrames > 0;
    return report;
  } finally {
    await handle.close();
  }
}
