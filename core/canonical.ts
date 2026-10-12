// Canonical Yamakan project, format "yamakan.project" version 1. This is what
// the workspace database stores. Time is integer flicks (core/time.ts). The
// 30 fps editing shape in core/project.ts is a lossless projection of this
// model used by the current editor until command reducers replace whole-
// project saves (T6); conversions that would lose information fail instead.
// The one normalization: a title's source offset, which nothing reads, is 0.
import { z } from "zod";
import { Id, ProjectSchema } from "./project.ts";
import type { Project } from "./project.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";
import {
  FLICKS_PER_SECOND,
  RationalSchema,
  Ticks,
  addTicks,
  framesToTicks,
  rational,
  ticksToFrames,
} from "./time.ts";
import { CommandError } from "./command/errors.ts";

export const FORMAT = "yamakan.project";
export const FORMAT_VERSION = 2;
const { mediaDimension, timelineFrames } = RESOURCE_POLICY.enforced;
// The timeline horizon stays the editor's ten minutes at 30 fps.
const MAX_TIMELINE_TICKS = framesToTicks(timelineFrames, rational(30, 1));

const CanonicalAsset = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    kind: z.enum(["image", "video", "audio"]),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    extension: z.enum([
      "png",
      "jpg",
      "jpeg",
      "webp",
      "mp4",
      "mov",
      "webm",
      "wav",
      "mp3",
      "ogg",
    ]),
    bytes: z
      .number()
      .int()
      .positive()
      .max(RESOURCE_POLICY.enforced.assetImportBytes),
    width: z.number().int().min(0).max(mediaDimension),
    height: z.number().int().min(0).max(mediaDimension),
    durationTicks: Ticks.max(MAX_TIMELINE_TICKS),
    // Stream time base from probing; null when imported before probing recorded it.
    timebase: RationalSchema.nullable(),
  })
  .strict();
const CanonicalTrack = z
  .object({
    id: Id,
    name: z.string().min(1).max(80),
    kind: z.enum(["video", "audio"]),
    muted: z.boolean(),
    locked: z.boolean(),
    solo: z.boolean(),
    targeted: z.boolean(),
  })
  .strict();
const CanonicalClip = z
  .object({
    id: Id,
    trackId: Id,
    assetId: Id.nullable(),
    startTicks: Ticks,
    durationTicks: Ticks.min(1),
    // Offset into the source media, in flicks from the source's first sample.
    sourceStartTicks: Ticks,
    title: z.string().max(500).nullable(),
    // v2: audio gain and linear fades. MVP renders them on audio clips only.
    gainDb: z.number().min(-60).max(12),
    fadeInTicks: Ticks,
    fadeOutTicks: Ticks,
  })
  .strict();
// v2: a shot is an ordered group of a scene's clips.
const CanonicalShot = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    clipIds: z.array(Id).max(200),
  })
  .strict();
const CanonicalScene = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    referenceAssetId: Id.nullable(),
    // Camera values are labelled intent, not an applied-conditioning receipt.
    camera: z
      .object({
        focalLengthMm: z.number().min(8).max(300),
        shotScale: z.enum(["wide", "medium", "close"]),
        movement: z.enum(["static", "dolly", "pan", "orbit"]),
      })
      .strict(),
    shots: z.array(CanonicalShot).max(100),
  })
  .strict();

const ProjectBody = z
  .object({
    format: z.literal(FORMAT),
    formatVersion: z.literal(FORMAT_VERSION),
    id: Id,
    name: z.string().min(1).max(120),
    revision: z.number().int().nonnegative().max(10000),
    language: z.enum(["en", "ar"]),
    output: z
      .object({
        width: z
          .number()
          .int()
          .min(16)
          .max(1920)
          .refine((x) => x % 2 === 0),
        height: z
          .number()
          .int()
          .min(16)
          .max(1080)
          .refine((x) => x % 2 === 0),
        fps: RationalSchema,
      })
      .strict(),
    assets: z
      .array(CanonicalAsset)
      .max(RESOURCE_POLICY.enforced.assetsPerProject),
    scenes: z.array(CanonicalScene).max(100),
    tracks: z.array(CanonicalTrack).max(16),
    clips: z.array(CanonicalClip).max(200),
  })
  .strict()
  .superRefine((p, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = [
      p.id,
      ...p.assets,
      ...p.scenes,
      ...p.scenes.flatMap((s) => s.shots),
      ...p.tracks,
      ...p.clips,
    ].map((x) => (typeof x === "string" ? x : x.id));
    if (new Set(ids).size !== ids.length) fail("Identifiers must be unique.");
    for (const s of p.scenes)
      if (
        s.referenceAssetId &&
        !p.assets.some((a) => a.id === s.referenceAssetId && a.kind === "image")
      )
        fail("Scene reference must identify an imported image.");
    const shotClips = p.scenes.flatMap((s) =>
      s.shots.flatMap((sh) => sh.clipIds),
    );
    if (new Set(shotClips).size !== shotClips.length)
      fail("A clip belongs to at most one shot.");
    for (const id of shotClips)
      if (!p.clips.some((c) => c.id === id)) fail("Shot clip is missing.");
    for (const c of p.clips) {
      const track = p.tracks.find((t) => t.id === c.trackId);
      if (c.fadeInTicks + c.fadeOutTicks > c.durationTicks)
        fail("Fades are longer than the clip.");
      const audible = track?.kind === "audio";
      if (!audible && (c.gainDb !== 0 || c.fadeInTicks || c.fadeOutTicks))
        fail("Gain and fades apply to audio clips only.");
      const asset = p.assets.find((a) => a.id === c.assetId);
      if (!track) fail("Clip track is missing.");
      let end: number;
      try {
        end = addTicks(c.startTicks, c.durationTicks);
      } catch {
        fail("Clip time is out of range.");
        continue;
      }
      if (end > MAX_TIMELINE_TICKS) fail("Timeline exceeds ten minutes.");
      if (c.title !== null) {
        if (c.assetId !== null || track?.kind !== "video")
          fail("Title requires a video track and no asset.");
        if (c.sourceStartTicks !== 0) fail("Titles have no source offset.");
      } else if (!asset) fail("Clip asset is missing.");
      else {
        if ((asset.kind === "audio") !== (track?.kind === "audio"))
          fail("Asset and track types do not match.");
        if (
          asset.kind !== "image" &&
          !(
            Number.isSafeInteger(c.sourceStartTicks + c.durationTicks) &&
            c.sourceStartTicks + c.durationTicks <= asset.durationTicks
          )
        )
          fail("Clip extends beyond its source.");
      }
    }
  });
// Own keys that alter prototypes when objects are copied or merged. Zod's
// strict mode does not report an own "__proto__" key, so it is checked here.
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function prototypeKey(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== "object") return false;
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) return true;
    if (prototypeKey((value as Record<string, unknown>)[key], depth + 1))
      return true;
  }
  return false;
}
export const CanonicalProjectSchema = z.preprocess((value, ctx) => {
  if (prototypeKey(value))
    ctx.addIssue({
      code: "custom",
      message: "Prototype keys are not allowed.",
    });
  return value;
}, ProjectBody);
export type CanonicalProject = z.output<typeof ProjectBody>;

// Bounded, write-free inspection of a stored snapshot whose format may be
// newer than this build. Never used to rewrite the snapshot.
export function inspectFormat(value: unknown): {
  format: string | null;
  formatVersion: number | null;
  supported: boolean;
} {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const format = typeof v.format === "string" ? v.format.slice(0, 80) : null;
  const formatVersion = Number.isSafeInteger(v.formatVersion)
    ? (v.formatVersion as number)
    : null;
  return {
    format,
    formatVersion,
    supported:
      format === FORMAT &&
      formatVersion !== null &&
      formatVersion >= 1 &&
      formatVersion <= FORMAT_VERSION,
  };
}

// v1 had no gain, fades or shots; their neutral values are exactly v1's meaning.
// v1 had no gain, fades or shots: they are added with neutral values. A
// document that claims v1 but already carries them is not a v1 project and
// is refused rather than silently overwritten.
function upgradeV1(value: Record<string, unknown>) {
  const clips = Array.isArray(value.clips) ? value.clips : [];
  const scenes = Array.isArray(value.scenes) ? value.scenes : [];
  const has = (x: unknown, keys: string[]) =>
    Boolean(x) && typeof x === "object" && keys.some((k) => k in (x as object));
  if (
    clips.some((c) => has(c, ["gainDb", "fadeInTicks", "fadeOutTicks"])) ||
    scenes.some((sc) => has(sc, ["shots"]))
  )
    throw new CommandError(
      "VALIDATION",
      "A version 1 project cannot contain version 2 fields.",
    );
  return {
    ...value,
    formatVersion: FORMAT_VERSION,
    clips: clips.map((c) =>
      c && typeof c === "object"
        ? { ...c, gainDb: 0, fadeInTicks: 0, fadeOutTicks: 0 }
        : c,
    ),
    scenes: scenes.map((sc) =>
      sc && typeof sc === "object" ? { ...sc, shots: [] } : sc,
    ),
  };
}

export function parseCanonical(value: unknown): CanonicalProject {
  const info = inspectFormat(value);
  if (!info.supported) {
    if (info.format === FORMAT && (info.formatVersion ?? 0) > FORMAT_VERSION)
      throw new CommandError(
        "RECOVERY_REQUIRED",
        `Project format version ${info.formatVersion} is newer than this build supports; it can be inspected but not edited.`,
      );
    throw new CommandError("VALIDATION", "Not a Yamakan project snapshot.");
  }
  return CanonicalProjectSchema.parse(
    info.formatVersion === 1
      ? upgradeV1(value as Record<string, unknown>)
      : value,
  );
}

const EDIT_FPS = rational(30, 1);
const toTicks = (frames: number) => framesToTicks(frames, EDIT_FPS);
const toFrames = (ticks: number, what: string) => {
  try {
    return ticksToFrames(ticks, EDIT_FPS, "exact");
  } catch {
    throw new CommandError(
      "CAPABILITY_UNAVAILABLE",
      `${what} is not frame-aligned at 30 fps; this editor cannot represent it without loss.`,
    );
  }
};

// Editing shape → canonical. Exact: one 30 fps frame is 23,520,000 flicks.
export function fromEditView(
  view: Project,
  language: "en" | "ar" = "en",
): CanonicalProject {
  const p = ProjectSchema.parse(view);
  return CanonicalProjectSchema.parse({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: p.id,
    name: p.name,
    revision: p.revision,
    language,
    output: { width: p.width, height: p.height, fps: rational(p.fps, 1) },
    assets: p.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      hash: a.hash,
      extension: a.extension,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      durationTicks: toTicks(a.durationFrames),
      timebase: null,
    })),
    scenes: p.scenes.map((sc) => ({ ...sc, shots: sc.shots ?? [] })),
    tracks: p.tracks.map((t) => ({
      ...t,
      solo: Boolean(t.solo),
      targeted: Boolean(t.targeted),
    })),
    clips: p.clips.map((c) => ({
      id: c.id,
      trackId: c.trackId,
      assetId: c.assetId,
      startTicks: toTicks(c.startFrame),
      durationTicks: toTicks(c.durationFrames),
      // Titles have no source media: the renderer never reads their offset,
      // so a stray editor value carries no meaning and is not preserved.
      sourceStartTicks: c.title === null ? toTicks(c.sourceFrame) : 0,
      title: c.title,
      gainDb: c.gainDb ?? 0,
      fadeInTicks: toTicks(c.fadeInFrames ?? 0),
      fadeOutTicks: toTicks(c.fadeOutFrames ?? 0),
    })),
  });
}

// Canonical → editing shape. Refuses anything the 30 fps editor cannot hold.
export function toEditView(project: CanonicalProject): Project {
  const p = CanonicalProjectSchema.parse(project);
  if (p.output.fps.num !== 30 || p.output.fps.den !== 1)
    throw new CommandError(
      "CAPABILITY_UNAVAILABLE",
      "This editor supports only 30 fps projects.",
    );
  for (const a of p.assets)
    if (a.timebase !== null) {
      // Recorded time bases are not representable in the editing shape yet.
      throw new CommandError(
        "CAPABILITY_UNAVAILABLE",
        "Source time bases require the timeline editor.",
      );
    }
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: p.id,
    name: p.name,
    revision: p.revision,
    fps: 30,
    width: p.output.width,
    height: p.output.height,
    assets: p.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      hash: a.hash,
      extension: a.extension,
      bytes: a.bytes,
      durationFrames: toFrames(a.durationTicks, "Asset duration"),
      width: a.width,
      height: a.height,
    })),
    scenes: p.scenes.map(({ shots, ...sc }) =>
      shots.length ? { ...sc, shots } : sc,
    ),
    tracks: p.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      muted: t.muted,
      locked: t.locked,
      ...(t.solo ? { solo: true } : {}),
      ...(t.targeted ? { targeted: true } : {}),
    })),
    clips: p.clips.map((c) => ({
      id: c.id,
      trackId: c.trackId,
      assetId: c.assetId,
      startFrame: toFrames(c.startTicks, "Clip start"),
      durationFrames: toFrames(c.durationTicks, "Clip duration"),
      sourceFrame: toFrames(c.sourceStartTicks, "Clip source offset"),
      title: c.title,
      ...(c.gainDb !== 0 ? { gainDb: c.gainDb } : {}),
      ...(c.fadeInTicks
        ? { fadeInFrames: toFrames(c.fadeInTicks, "Clip fade-in") }
        : {}),
      ...(c.fadeOutTicks
        ? { fadeOutFrames: toFrames(c.fadeOutTicks, "Clip fade-out") }
        : {}),
    })),
  });
}

export { FLICKS_PER_SECOND };
