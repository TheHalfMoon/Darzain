import path from "node:path";
import { RESOURCE_POLICY } from "./command/policy.ts";
import { CommandError } from "./command/errors.ts";
import { mediaTools, workers } from "./process/workers.ts";
export const MAX_ASSET_BYTES = RESOURCE_POLICY.enforced.assetImportBytes;
const { mediaDimension, probeStreams, probeWallSeconds, workerMemoryBytes } =
  RESOURCE_POLICY.enforced;
const MAX_PROBE_OUTPUT = 1024 * 1024;

// "num/den" from ffprobe, reduced to a positive rational, or null.
function ratio(text: unknown) {
  const m = /^(\d{1,10})\/(\d{1,10})$/.exec(String(text ?? ""));
  if (!m || m[1] === "0" || m[2] === "0") return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const d = g(a, b);
  return { num: a / d, den: b / d };
}
export function mediaHeader(bytes: Buffer, ext: string) {
  const valid =
    ext === "png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ["jpg", "jpeg"].includes(ext)
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : ext === "webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : ["mp4", "mov"].includes(ext)
            ? ["ftyp", "moov", "mdat", "wide"].includes(
                bytes.toString("ascii", 4, 8),
              )
            : ext === "webm"
              ? bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
              : ext === "wav"
                ? bytes.toString("ascii", 0, 4) === "RIFF" &&
                  bytes.toString("ascii", 8, 12) === "WAVE"
                : ext === "ogg"
                  ? bytes.toString("ascii", 0, 4) === "OggS"
                  : ext === "mp3"
                    ? bytes.toString("ascii", 0, 3) === "ID3" ||
                      (bytes[0] === 255 && (bytes[1] & 224) === 224)
                    : false;
  if (!valid)
    throw new Error("Media signature does not match a supported format.");
}
// Probes a staged file with an owned, bounded ffprobe: local files only (no
// network, pipes or playlist subresources), a wall-clock and memory limit,
// and bounded output. Failures never echo the command line or stderr.
export async function probe(file: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeWallSeconds * 1000);
  let result;
  try {
    result = await workers().run({
      executable: mediaTools().ffprobe,
      args: [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path.basename(file),
      ],
      cwd: path.dirname(file),
      memoryBytes: workerMemoryBytes,
      signal: controller.signal,
      onStdout: (b) => {
        size += b.length;
        if (size > MAX_PROBE_OUTPUT) controller.abort();
        else chunks.push(b);
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted || result.code !== 0)
    throw new CommandError(
      "MEDIA_INVALID",
      "Media probe failed; the file is unreadable or unsupported.",
    );
  const info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const streams = info.streams || [];
  const visual = streams.find((x: any) => x.codec_type === "video");
  const audio = streams.find((x: any) => x.codec_type === "audio");
  if (streams.length > probeStreams || (!visual && !audio))
    throw new Error("Unsupported media streams.");
  const width = Number(visual?.width || 0);
  const height = Number(visual?.height || 0);
  if (width > mediaDimension || height > mediaDimension)
    throw new Error(`Media dimensions exceed ${mediaDimension} pixels.`);
  const duration = Number(
    info.format?.duration || visual?.duration || audio?.duration || 0,
  );
  if (!Number.isFinite(duration) || duration > 600)
    throw new Error("Media exceeds ten minutes.");
  // A differing nominal and average rate marks variable frame rate; editing
  // such sources waits for a constant-rate derivative (T5).
  const nominal = ratio(visual?.r_frame_rate);
  const average = ratio(visual?.avg_frame_rate);
  const isStill = Number(visual?.nb_frames) === 1 || duration === 0;
  return {
    width,
    height,
    durationFrames: Math.floor(duration * 30),
    hasVideo: Boolean(visual),
    hasAudio: Boolean(audio),
    format: String(info.format?.format_name || ""),
    timebase: ratio((visual ?? audio)?.time_base),
    frameRate: nominal,
    variableFrameRate: Boolean(
      visual &&
      !isStill &&
      nominal &&
      average &&
      nominal.num * average.den !== average.num * nominal.den,
    ),
  };
}
