// Canonical render plan (plan T7, contract "Canonical render plan"). An
// immutable, versioned description of exactly what a render draws: derived
// only from the canonical project at one revision, its asset hashes, the
// output profile, the compiled title script and the pinned font hashes.
// It holds no paths, URLs, filters or free text other than title cues;
// export and (in T8) reference preview both render from it.
import { createHash } from "node:crypto";
import type { CanonicalProject } from "../canonical.ts";
import type { Rational } from "../time.ts";
import { addTicks } from "../time.ts";
import { CommandError } from "../command/errors.ts";
import { ASS_COMPILER_VERSION, compileTitles } from "./ass.ts";
import type { TitleCue } from "./ass.ts";
import type { PinnedFont } from "./fonts.ts";

export const RENDER_PLAN_FORMAT = "yamakan.render-plan/v1";
export const COMPILER_VERSION = "yamakan.render-compiler/1";

// MVP output profile: SDR 8-bit 4:2:0, square pixels, fixed rational frame
// rate, 48 kHz stereo, picture fit inside the frame (letterboxed).
export type OutputProfile = {
  width: number;
  height: number;
  fps: Rational;
  sampleRate: 48000;
  pixelFormat: "yuv420p";
  fit: "contain";
};

export type VideoLayer = {
  clipId: string;
  track: number;
  kind: "video" | "image";
  assetId: string;
  assetSha256: string;
  startTicks: number;
  durationTicks: number;
  sourceStartTicks: number;
};

export type AudioInstruction = {
  clipId: string;
  track: number;
  assetId: string;
  assetSha256: string;
  startTicks: number;
  durationTicks: number;
  sourceStartTicks: number;
  gainDb: number;
  fadeInTicks: number;
  fadeOutTicks: number;
};

export type RenderPlan = {
  format: typeof RENDER_PLAN_FORMAT;
  compilerVersion: typeof COMPILER_VERSION;
  projectId: string;
  revision: number;
  snapshotHash: string;
  profile: OutputProfile;
  durationTicks: number;
  layers: VideoLayer[];
  audio: AudioInstruction[];
  titles: {
    compiler: typeof ASS_COMPILER_VERSION;
    sha256: string;
    cues: TitleCue[];
  } | null;
  fonts: { name: string; sha256: string }[];
  planHash: string;
};

export type CompiledPlan = { plan: RenderPlan; ass: string | null };

// Compiles the plan for `project` at its revision. `snapshotHash` is the
// stored snapshot the project was read from.
export function compilePlan(
  project: CanonicalProject,
  snapshotHash: string,
  fonts: PinnedFont[],
): CompiledPlan {
  if (!/^[a-f0-9]{64}$/.test(snapshotHash))
    throw new CommandError("VALIDATION", "Snapshot hash is invalid.");
  const trackIndex = new Map(project.tracks.map((t, i) => [t.id, i]));
  // Mute removes a track; solo on any track of a kind keeps only soloed
  // tracks of that kind.
  const audible = (trackId: string) => {
    const track = project.tracks.find((t) => t.id === trackId)!;
    const soloed = project.tracks.some((t) => t.kind === track.kind && t.solo);
    return !track.muted && (!soloed || track.solo);
  };
  const active = project.clips
    .filter((c) => audible(c.trackId))
    .sort(
      (a, b) =>
        trackIndex.get(a.trackId)! - trackIndex.get(b.trackId)! ||
        a.startTicks - b.startTicks ||
        a.id.localeCompare(b.id),
    );
  const kindOf = (trackId: string) =>
    project.tracks.find((t) => t.id === trackId)!.kind;
  const asset = (id: string) => project.assets.find((a) => a.id === id)!;
  const layers: VideoLayer[] = [];
  const audio: AudioInstruction[] = [];
  const cues: TitleCue[] = [];
  for (const c of active) {
    const track = trackIndex.get(c.trackId)!;
    if (c.title !== null) {
      cues.push({
        layer: track,
        startTicks: c.startTicks,
        endTicks: addTicks(c.startTicks, c.durationTicks),
        text: c.title,
      });
      continue;
    }
    const a = asset(c.assetId!);
    const timing = {
      clipId: c.id,
      track,
      assetId: a.id,
      assetSha256: a.hash,
      startTicks: c.startTicks,
      durationTicks: c.durationTicks,
      sourceStartTicks: c.sourceStartTicks,
    };
    if (kindOf(c.trackId) === "audio" || a.kind === "audio")
      audio.push({
        ...timing,
        gainDb: c.gainDb,
        fadeInTicks: c.fadeInTicks,
        fadeOutTicks: c.fadeOutTicks,
      });
    else
      layers.push({ ...timing, kind: a.kind === "image" ? "image" : "video" });
  }
  if (!layers.length && !cues.length)
    throw new CommandError(
      "VALIDATION",
      "Timeline has no active picture or title.",
    );
  const durationTicks = Math.max(
    ...active.map((c) => addTicks(c.startTicks, c.durationTicks)),
  );
  const profile: OutputProfile = {
    width: project.output.width,
    height: project.output.height,
    fps: project.output.fps,
    sampleRate: 48000,
    pixelFormat: "yuv420p",
    fit: "contain",
  };
  const compiled = cues.length
    ? compileTitles(cues, profile.width, profile.height, fonts)
    : null;
  const body: Omit<RenderPlan, "planHash"> = {
    format: RENDER_PLAN_FORMAT,
    compilerVersion: COMPILER_VERSION,
    projectId: project.id,
    revision: project.revision,
    snapshotHash,
    profile,
    durationTicks,
    layers,
    audio,
    titles: compiled
      ? { compiler: ASS_COMPILER_VERSION, sha256: compiled.sha256, cues }
      : null,
    fonts: compiled
      ? fonts.map((f) => ({ name: f.name, sha256: f.sha256 }))
      : [],
  };
  const planHash = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return { plan: { ...body, planHash }, ass: compiled?.ass ?? null };
}
