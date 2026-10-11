import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;
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
export async function probe(file: string) {
  const { stdout } = await execute(
    process.env.DARZAIN_FFPROBE || "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const visual = streams.find((x: any) => x.codec_type === "video");
  const audio = streams.find((x: any) => x.codec_type === "audio");
  if (streams.length > 10 || (!visual && !audio))
    throw new Error("Unsupported media streams.");
  const width = Number(visual?.width || 0);
  const height = Number(visual?.height || 0);
  if (width > 4096 || height > 4096)
    throw new Error("Media dimensions exceed 4096 pixels.");
  const duration = Number(
    info.format?.duration || visual?.duration || audio?.duration || 0,
  );
  if (!Number.isFinite(duration) || duration > 600)
    throw new Error("Media exceeds ten minutes.");
  return {
    width,
    height,
    durationFrames: Math.floor(duration * 30),
    hasVideo: Boolean(visual),
    hasAudio: Boolean(audio),
    format: String(info.format?.format_name || ""),
  };
}
