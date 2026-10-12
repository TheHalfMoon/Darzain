// Title capability probe (plan T7: "capability probe fails closed"). Titles
// need FFmpeg's ass filter backed by libass 0.17 or newer: automatic base
// direction (Encoding -1) arrived in 0.17.0, and libass shapes with
// HarfBuzz and FriBidi. The probe renders a one-frame script through an
// owned worker and reads libass's reported API version; anything else
// refuses title rendering rather than producing unshaped text.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandError } from "../command/errors.ts";
import { mediaTools, workers } from "../process/workers.ts";

const MIN_LIBASS_API = 0x01700000;

// The libass API version FFmpeg reports in its log, or 0 when absent.
export function libassApi(log: string): number {
  const match = /libass API version: 0x([0-9a-f]{1,8})\b/i.exec(log);
  return match ? parseInt(match[1], 16) : 0;
}
// Titles render only with the qualified libass (automatic base direction).
export function titlesSupported(api: number) {
  return api >= MIN_LIBASS_API;
}

export type TitleCapability = { libassApi: number };

let probed: Promise<TitleCapability> | null = null;

export function titleCapability(): Promise<TitleCapability> {
  probed ??= probeTitles().catch((e) => {
    probed = null;
    throw e;
  });
  return probed;
}

async function probeTitles(): Promise<TitleCapability> {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-ass-probe-"));
  try {
    await writeFile(
      path.join(dir, "probe.ass"),
      "[Script Info]\nScriptType: v4.00+\nPlayResX: 16\nPlayResY: 16\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n",
    );
    let log = "";
    const result = await workers().run({
      executable: mediaTools().ffmpeg,
      args: [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "verbose",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:d=0.04",
        "-vf",
        "ass=probe.ass",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      cwd: dir,
      stderrLimit: 64_000,
      onStderr: (chunk: Buffer) => {
        if (log.length < 64_000) log += chunk.toString("utf8");
      },
    });
    const api = libassApi(log || result.stderr);
    if (result.code !== 0 || !titlesSupported(api))
      throw new CommandError(
        "CAPABILITY_UNAVAILABLE",
        "Titles need FFmpeg with libass 0.17 or newer (automatic text direction and complex shaping).",
      );
    return { libassApi: api };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
