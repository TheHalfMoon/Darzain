// Timeline operations (plan T6): typed, bounded edits applied as pure
// reducers to the canonical project. A batch applies every operation in order
// to a copy and validates the result once; any failure rejects the whole
// batch, so nothing is committed. IDs are supplied by the caller, which makes
// the same operations produce the same snapshot whether they come from the
// editor or from an agent.
import { z } from "zod";
import { Id } from "../project.ts";
import { Ticks, addTicks } from "../time.ts";
import { CanonicalProjectSchema } from "../canonical.ts";
import type { CanonicalProject } from "../canonical.ts";
import { CommandError } from "../command/errors.ts";
import { canPlaceTimeSpansOnTrack } from "../donors/opencut/overlap.ts";
import { resolveTimelineSnap } from "../donors/opencut/snapping.ts";
import type { SnapPoint } from "../donors/opencut/snapping.ts";

// The widest snap an operation may ask for: one second.
const MAX_SNAP_TICKS = 705_600_000;

const Name = z.string().min(1).max(120);
const Camera = z
  .object({
    focalLengthMm: z.number().min(8).max(300),
    shotScale: z.enum(["wide", "medium", "close"]),
    movement: z.enum(["static", "dolly", "pan", "orbit"]),
  })
  .strict();

export const OperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("track.add"),
      trackId: Id,
      name: z.string().min(1).max(80),
      kind: z.enum(["video", "audio"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("track.update"),
      trackId: Id,
      name: z.string().min(1).max(80).optional(),
      muted: z.boolean().optional(),
      locked: z.boolean().optional(),
      solo: z.boolean().optional(),
      targeted: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("track.remove"), trackId: Id }).strict(),
  z
    .object({
      type: z.literal("clip.add"),
      clipId: Id,
      trackId: Id,
      assetId: Id.nullable(),
      title: z.string().max(500).nullable(),
      startTicks: Ticks,
      durationTicks: Ticks.min(1),
      sourceStartTicks: Ticks,
    })
    .strict(),
  z
    .object({
      type: z.literal("clip.trim"),
      clipId: Id,
      // New timeline start and/or end; trimming the start moves the source in-point too.
      startTicks: Ticks.optional(),
      endTicks: Ticks.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("clip.split"),
      clipId: Id,
      atTicks: Ticks,
      newClipId: Id,
    })
    .strict(),
  z
    .object({
      type: z.literal("clip.move"),
      clipId: Id,
      trackId: Id.optional(),
      startTicks: Ticks,
      // Snap the clip's start or end to the nearest other clip edge within
      // this distance (as an editor drag does); the result is still checked.
      snapTicks: Ticks.max(MAX_SNAP_TICKS).optional(),
    })
    .strict(),
  z.object({ type: z.literal("clip.remove"), clipId: Id }).strict(),
  z
    .object({
      type: z.literal("clip.setTitle"),
      clipId: Id,
      title: z.string().max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("clip.setAudio"),
      clipId: Id,
      gainDb: z.number().min(-60).max(12).optional(),
      fadeInTicks: Ticks.optional(),
      fadeOutTicks: Ticks.optional(),
    })
    .strict(),
  z.object({ type: z.literal("scene.add"), sceneId: Id, name: Name }).strict(),
  z
    .object({
      type: z.literal("scene.update"),
      sceneId: Id,
      name: Name.optional(),
      referenceAssetId: Id.nullable().optional(),
      camera: Camera.optional(),
    })
    .strict(),
  z.object({ type: z.literal("scene.remove"), sceneId: Id }).strict(),
  z
    .object({
      type: z.literal("shot.add"),
      sceneId: Id,
      shotId: Id,
      name: Name,
      clipIds: z.array(Id).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("shot.update"),
      shotId: Id,
      name: Name.optional(),
      clipIds: z.array(Id).max(200).optional(),
    })
    .strict(),
  z.object({ type: z.literal("shot.remove"), shotId: Id }).strict(),
]);
export type Operation = z.infer<typeof OperationSchema>;
export const BatchSchema = z.array(OperationSchema).min(1).max(64);

const invalid = (message: string) => new CommandError("VALIDATION", message);

function track(p: CanonicalProject, id: string) {
  const t = p.tracks.find((t) => t.id === id);
  if (!t) throw invalid("Track not found.");
  return t;
}
function clip(p: CanonicalProject, id: string) {
  const c = p.clips.find((c) => c.id === id);
  if (!c) throw invalid("Clip not found.");
  return c;
}
function unlocked(p: CanonicalProject, trackId: string) {
  if (track(p, trackId).locked) throw invalid("Track is locked.");
}
// Clips on one track never overlap (OpenCut placement rule).
function placeable(
  p: CanonicalProject,
  trackId: string,
  startTime: number,
  duration: number,
  excludeElementId?: string,
) {
  const elements = p.clips.filter((c) => c.trackId === trackId);
  if (
    !canPlaceTimeSpansOnTrack({
      track: { elements },
      timeSpans: [{ startTime, duration, excludeElementId }],
    })
  )
    throw invalid("Clips on a track cannot overlap.");
}
const end = (c: { startTicks: number; durationTicks: number }) =>
  addTicks(c.startTicks, c.durationTicks);

function apply(p: CanonicalProject, op: Operation): void {
  switch (op.type) {
    case "track.add":
      p.tracks.push({
        id: op.trackId,
        name: op.name,
        kind: op.kind,
        muted: false,
        locked: false,
        solo: false,
        targeted: false,
      });
      return;
    case "track.update": {
      const t = track(p, op.trackId);
      for (const key of [
        "name",
        "muted",
        "locked",
        "solo",
        "targeted",
      ] as const)
        if (op[key] !== undefined) Object.assign(t, { [key]: op[key] });
      return;
    }
    case "track.remove":
      track(p, op.trackId);
      if (p.clips.some((c) => c.trackId === op.trackId))
        throw invalid("Only an empty track can be removed.");
      p.tracks = p.tracks.filter((t) => t.id !== op.trackId);
      return;
    case "clip.add":
      unlocked(p, op.trackId);
      placeable(p, op.trackId, op.startTicks, op.durationTicks);
      p.clips.push({
        id: op.clipId,
        trackId: op.trackId,
        assetId: op.assetId,
        title: op.title,
        startTicks: op.startTicks,
        durationTicks: op.durationTicks,
        sourceStartTicks: op.sourceStartTicks,
        gainDb: 0,
        fadeInTicks: 0,
        fadeOutTicks: 0,
      });
      return;
    case "clip.trim": {
      const c = clip(p, op.clipId);
      unlocked(p, c.trackId);
      const newStart = op.startTicks ?? c.startTicks;
      const newEnd = op.endTicks ?? end(c);
      if (newEnd <= newStart) throw invalid("A clip must keep a duration.");
      const shift = newStart - c.startTicks;
      const source = c.sourceStartTicks + (c.title === null ? shift : 0);
      if (source < 0) throw invalid("Trim extends before the source.");
      placeable(p, c.trackId, newStart, newEnd - newStart, c.id);
      c.startTicks = newStart;
      c.durationTicks = newEnd - newStart;
      c.sourceStartTicks = c.title === null ? source : 0;
      c.fadeInTicks = Math.min(c.fadeInTicks, c.durationTicks);
      c.fadeOutTicks = Math.min(
        c.fadeOutTicks,
        c.durationTicks - c.fadeInTicks,
      );
      return;
    }
    case "clip.split": {
      const c = clip(p, op.clipId);
      unlocked(p, c.trackId);
      if (op.atTicks <= c.startTicks || op.atTicks >= end(c))
        throw invalid("Split point must fall inside the clip.");
      const first = op.atTicks - c.startTicks;
      const second = {
        ...c,
        id: op.newClipId,
        startTicks: op.atTicks,
        durationTicks: c.durationTicks - first,
        sourceStartTicks: c.title === null ? c.sourceStartTicks + first : 0,
        fadeInTicks: 0,
        fadeOutTicks: Math.min(c.fadeOutTicks, c.durationTicks - first),
      };
      c.durationTicks = first;
      c.fadeOutTicks = 0;
      c.fadeInTicks = Math.min(c.fadeInTicks, first);
      p.clips.push(second);
      // The new clip joins the same shot as the clip it came from.
      for (const s of p.scenes)
        for (const shot of s.shots) {
          const at = shot.clipIds.indexOf(c.id);
          if (at >= 0) shot.clipIds.splice(at + 1, 0, second.id);
        }
      return;
    }
    case "clip.move": {
      const c = clip(p, op.clipId);
      const target = op.trackId ?? c.trackId;
      unlocked(p, c.trackId);
      unlocked(p, target);
      if (track(p, target).kind !== track(p, c.trackId).kind)
        throw invalid("Clips move only between tracks of the same kind.");
      const start = op.snapTicks
        ? snapStart(p, c, op.startTicks, op.snapTicks)
        : op.startTicks;
      placeable(p, target, start, c.durationTicks, c.id);
      c.trackId = target;
      c.startTicks = start;
      return;
    }
    case "clip.remove": {
      const c = clip(p, op.clipId);
      unlocked(p, c.trackId);
      p.clips = p.clips.filter((x) => x.id !== c.id);
      for (const s of p.scenes)
        for (const shot of s.shots)
          shot.clipIds = shot.clipIds.filter((id) => id !== c.id);
      return;
    }
    case "clip.setTitle": {
      const c = clip(p, op.clipId);
      unlocked(p, c.trackId);
      if (c.title === null) throw invalid("Only a title clip has text.");
      c.title = op.title;
      return;
    }
    case "clip.setAudio": {
      const c = clip(p, op.clipId);
      unlocked(p, c.trackId);
      if (op.gainDb !== undefined) c.gainDb = op.gainDb;
      if (op.fadeInTicks !== undefined) c.fadeInTicks = op.fadeInTicks;
      if (op.fadeOutTicks !== undefined) c.fadeOutTicks = op.fadeOutTicks;
      return;
    }
    case "scene.add":
      p.scenes.push({
        id: op.sceneId,
        name: op.name,
        referenceAssetId: null,
        camera: { focalLengthMm: 35, shotScale: "medium", movement: "static" },
        shots: [],
      });
      return;
    case "scene.update": {
      const s = p.scenes.find((s) => s.id === op.sceneId);
      if (!s) throw invalid("Scene not found.");
      if (op.name !== undefined) s.name = op.name;
      if (op.referenceAssetId !== undefined)
        s.referenceAssetId = op.referenceAssetId;
      if (op.camera !== undefined) s.camera = op.camera;
      return;
    }
    case "scene.remove":
      if (!p.scenes.some((s) => s.id === op.sceneId))
        throw invalid("Scene not found.");
      p.scenes = p.scenes.filter((s) => s.id !== op.sceneId);
      return;
    case "shot.add": {
      const s = p.scenes.find((s) => s.id === op.sceneId);
      if (!s) throw invalid("Scene not found.");
      s.shots.push({ id: op.shotId, name: op.name, clipIds: op.clipIds });
      return;
    }
    case "shot.update": {
      const shot = p.scenes
        .flatMap((s) => s.shots)
        .find((s) => s.id === op.shotId);
      if (!shot) throw invalid("Shot not found.");
      if (op.name !== undefined) shot.name = op.name;
      if (op.clipIds !== undefined) shot.clipIds = op.clipIds;
      return;
    }
    case "shot.remove": {
      const scene = p.scenes.find((s) =>
        s.shots.some((x) => x.id === op.shotId),
      );
      if (!scene) throw invalid("Shot not found.");
      scene.shots = scene.shots.filter((x) => x.id !== op.shotId);
      return;
    }
  }
}

// The start a moved clip snaps to: whichever of its start or end lies closer
// to another clip's edge (on any track), within the threshold.
function snapStart(
  p: CanonicalProject,
  moving: CanonicalProject["clips"][number],
  startTicks: number,
  snapTicks: number,
) {
  const points: SnapPoint[] = p.clips
    .filter((x) => x.id !== moving.id)
    .flatMap((x) => [
      { time: x.startTicks, type: "element-start" as const, elementId: x.id },
      { time: end(x), type: "element-end" as const, elementId: x.id },
    ]);
  const byStart = resolveTimelineSnap({
    targetTime: startTicks,
    snapPoints: points,
    maxSnapDistance: snapTicks,
  });
  const byEnd = resolveTimelineSnap({
    targetTime: startTicks + moving.durationTicks,
    snapPoints: points,
    maxSnapDistance: snapTicks,
  });
  if (byEnd.snapDistance < byStart.snapDistance) {
    const snapped = byEnd.snappedTime - moving.durationTicks;
    if (snapped >= 0) return snapped;
  }
  return byStart.snappedTime;
}

// Applies a whole batch to a copy and validates the result once.
export function applyBatch(
  project: CanonicalProject,
  operations: Operation[],
): CanonicalProject {
  const ops = BatchSchema.parse(operations);
  const next = structuredClone(project);
  ops.forEach((op, index) => {
    try {
      apply(next, op);
    } catch (e) {
      if (e instanceof CommandError)
        throw new CommandError(
          e.code,
          `Operation ${index + 1} (${op.type}): ${e.message}`,
        );
      throw e;
    }
  });
  const checked = CanonicalProjectSchema.safeParse(next);
  if (!checked.success)
    throw invalid(
      `The batch would leave an invalid project: ${checked.error.issues[0]?.message ?? "invalid"}`,
    );
  return checked.data;
}
