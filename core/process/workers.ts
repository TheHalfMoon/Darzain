// The service's media workers: FFmpeg and ffprobe resolved to absolute paths
// once, launched only through one ProcessOwner (core/process/owner.ts).
import { ProcessOwner, resolveExecutable } from "./owner.ts";

const env = (name: string) =>
  process.env[`YAMAKAN_${name}`] || process.env[`DARZAIN_${name}`];

let tools: { ffmpeg: string; ffprobe: string } | null = null;
let owner: ProcessOwner | null = null;

export function mediaTools() {
  tools ??= {
    ffmpeg: resolveExecutable(env("FFMPEG") || "ffmpeg"),
    ffprobe: resolveExecutable(env("FFPROBE") || "ffprobe"),
  };
  return tools;
}

export function workers(): ProcessOwner {
  if (!owner) {
    const { ffmpeg, ffprobe } = mediaTools();
    owner = new ProcessOwner([ffmpeg, ffprobe]);
  }
  return owner;
}

// Ends every running worker; called on service shutdown.
export function closeWorkers() {
  owner?.close();
  owner = null;
}
