// Read-only inspection of a SQLite write-ahead log (file format:
// https://www.sqlite.org/fileformat.html#the_write_ahead_log). SQLite reads
// frames from the start and stops, silently, at the first frame whose
// salts or cumulative checksum do not match; committed transactions after
// a damaged frame are then lost without an error, and the log is deleted
// at the next checkpoint. This finds that case before anything opens it.
//
// With synchronous=FULL the log is synced at every commit, so every
// transaction but the last one written was durable. A power cut can tear
// any frame of that last, unsynced transaction (the system may write its
// pages in any order, or leave zero-filled gaps), and SQLite then drops
// just that transaction: an unsynced tail, which is normal. Damage is
// proven only when a current-generation frame (the header's salts) follows
// a commit frame after the first unreadable frame: that commit was synced
// before anything after it was written, so it and everything before it
// were durable, and SQLite would skip them. Frames with other salts are
// left from before a log restart and are ignored, as SQLite does.
// Limitation: damage confined to the last transaction cannot be told apart
// from a torn write and is not reported.
import { open } from "node:fs/promises";

export type WalReport = {
  bytes: number;
  pageSize: number | null;
  headerValid: boolean;
  validFrames: number;
  validCommits: number;
  // Current-generation frames from the first unreadable one on.
  unreadableFrames: number;
  // Commit frames among them; at most one may be an unsynced final write.
  lostCommits: number;
  // An unreadable tail that is only the last, unsynced transaction.
  unsyncedTail: boolean;
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
      unsyncedTail: false,
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
    // Current-generation frames found after a lost commit frame.
    let afterCommit = 0;
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
      }
      if (!current) continue;
      report.unreadableFrames++;
      if (report.lostCommits > 0) afterCommit++;
      if (commit) report.lostCommits++;
    }
    report.damaged = afterCommit > 0;
    report.unsyncedTail = report.unreadableFrames > 0 && !report.damaged;
    return report;
  } finally {
    await handle.close();
  }
}
