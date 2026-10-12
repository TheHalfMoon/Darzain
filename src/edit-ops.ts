// The editor's timeline edits on its local 30 fps edit view. Split and delete
// run the same typed operations as agents and tools (core/timeline), so both
// paths produce identical projects: shots keep their order, fades are
// clamped, and invariants are checked once. Drag and trim updates from the
// timeline component are converted here and clamp fades with the same rule.
import type { Clip, Project } from "../core/project.ts";
import { fromEditView, toEditView } from "../core/canonical.ts";
import { applyBatch, clampFades } from "../core/timeline/operations.ts";
import type { Operation } from "../core/timeline/operations.ts";
import type { TimelineClip } from "./donors/film-editor/types";

// Flicks per frame of the 30 fps edit view.
export const FRAME_TICKS = 23_520_000;

// Applies operations to the local edit view; the revision is unchanged until
// the project is saved.
export function applyLocal(p: Project, operations: Operation[]): Project {
  return {
    ...toEditView(applyBatch(fromEditView(p), operations)),
    revision: p.revision,
  };
}

// Splits a clip at `seconds` on the timeline. Locked tracks and split points
// outside the clip leave the project unchanged.
export function splitClip(
  p: Project,
  clipId: string,
  seconds: number,
  newClipId: string,
): Project {
  const c = p.clips.find((c) => c.id === clipId);
  if (!c || p.tracks.find((t) => t.id === c.trackId)?.locked) return p;
  const at = Math.round(seconds * 30);
  if (at <= c.startFrame || at >= c.startFrame + c.durationFrames) return p;
  return applyLocal(p, [
    {
      type: "clip.split",
      clipId,
      atTicks: at * FRAME_TICKS,
      newClipId,
    },
  ]);
}

// Removes a clip (and its place in any shot) unless its track is locked.
export function deleteClip(p: Project, clipId: string | null): Project {
  const c = p.clips.find((c) => c.id === clipId);
  if (!c || p.tracks.find((t) => t.id === c.trackId)?.locked) return p;
  return applyLocal(p, [{ type: "clip.remove", clipId: c.id }]);
}

// Applies drag and trim updates from the timeline component. Clips on locked
// tracks are not moved; fades are clamped to the new duration.
export function updateClips(p: Project, updates: TimelineClip[]): Project {
  return {
    ...p,
    clips: updates.reduce((clips, c) => {
      const existing = clips.find((x) => x.id === c.id);
      const old =
        existing ||
        clips.find(
          (x) => x.assetId === c.mediaId || `title-${x.id}` === c.mediaId,
        );
      if (!old) return clips;
      if (
        (existing && p.tracks.find((t) => t.id === old.trackId)?.locked) ||
        p.tracks.find((t) => t.id === c.trackId)?.locked
      )
        return clips;
      const durationFrames = Math.max(1, Math.round((c.end - c.start) * 30));
      const [fadeInFrames, fadeOutFrames] = clampFades(
        durationFrames,
        old.fadeInFrames ?? 0,
        old.fadeOutFrames ?? 0,
      );
      const converted: Clip = {
        ...old,
        id: c.id,
        trackId: c.trackId,
        startFrame: Math.max(0, Math.round(c.start * 30)),
        durationFrames,
        sourceFrame:
          old.title !== null
            ? 0
            : Math.max(0, Math.round((c.sourceIn || 0) * 30)),
        ...(old.fadeInFrames !== undefined || old.fadeOutFrames !== undefined
          ? { fadeInFrames, fadeOutFrames }
          : {}),
      };
      return clips.some((x) => x.id === c.id)
        ? clips.map((x) => (x.id === c.id ? converted : x))
        : [...clips, converted];
    }, p.clips),
  };
}
