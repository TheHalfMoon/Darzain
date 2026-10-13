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
// The container families Yamakan accepts, for every FFmpeg or ffprobe input;
// no playlist or concat demuxers.
export const MEDIA_FORMATS =
  "mov,matroska,wav,mp3,ogg,png_pipe,jpeg_pipe,webp_pipe,image2";

// Rotation in degrees from a stream's display matrix or legacy rotate tag.
function rotation(stream: any): number {
  const matrix = (stream?.side_data_list ?? []).find(
    (d: any) => d?.side_data_type === "Display Matrix",
  );
  const value = Number(matrix?.rotation ?? stream?.tags?.rotate ?? 0);
  return Number.isFinite(value) ? Math.round(value) : 0;
}

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
        // Only the container families Yamakan accepts; no playlist or concat demuxers.
        "-format_whitelist",
        MEDIA_FORMATS,
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        `file:${path.basename(file)}`,
      ],
      cwd: path.dirname(file),
      // The probe may read only the file it probes.
      readable: [file],
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
  // Display dimensions: FFmpeg applies a ±90° display rotation whenever it
  // decodes (renders and conversions), so the upright size is the real one.
  const turned = Math.abs(rotation(visual)) % 180 === 90;
  const width = Number((turned ? visual?.height : visual?.width) || 0);
  const height = Number((turned ? visual?.width : visual?.height) || 0);
  if (width > mediaDimension || height > mediaDimension)
    throw new Error(`Media dimensions exceed ${mediaDimension} pixels.`);
  // A picture whose size the decoder could not read (a forged header, an
  // image bomb it refused) is not imported as a zero-sized picture.
  if (visual && (width <= 0 || height <= 0))
    throw new CommandError(
      "MEDIA_INVALID",
      "Media probe failed; the file is unreadable or unsupported.",
    );
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
    averageFrameRate: average,
    variableFrameRate: Boolean(
      visual &&
      !isStill &&
      nominal &&
      average &&
      nominal.num * average.den !== average.num * nominal.den,
    ),
  };
}
