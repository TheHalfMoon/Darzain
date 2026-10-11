import type { Project } from "../core/project.ts";
import type {
  TimelineClip,
  TimelineTrack,
  MediaItem,
} from "./donors/film-editor/types";
export function editorView(p: Project) {
  const tracks: TimelineTrack[] = p.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.kind,
    isMuted: t.muted,
    isLocked: t.locked,
    isSolo: Boolean(t.solo),
    isTargeted: Boolean(t.targeted),
  }));
  const media: MediaItem[] = p.assets.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.kind,
    source: "upload",
    url: `/api/v1/projects/${p.id}/assets/${a.id}`,
    duration: a.durationFrames / 30,
  }));
  const clips: TimelineClip[] = p.clips.map((c) => ({
    id: c.id,
    trackId: c.trackId,
    mediaId: c.assetId || `title-${c.id}`,
    start: c.startFrame / 30,
    end: (c.startFrame + c.durationFrames) / 30,
    duration: c.durationFrames / 30,
    speed: 1,
    sourceIn: c.sourceFrame / 30,
    sourceOut: (c.sourceFrame + c.durationFrames) / 30,
    effect: null,
    ...(c.title !== null
      ? {
          textConfig: {
            content: c.title,
            font: "sans-serif",
            size: Math.round(p.height / 15),
            color: "#ffffff",
            position: "bottom-center" as const,
            background: {
              enabled: true,
              color: "#000000",
              opacity: 0.65,
              paddingX: 12,
              paddingY: 12,
              radius: 0,
            },
          },
        }
      : {}),
  }));
  for (const c of p.clips.filter((c) => c.title !== null))
    media.push({
      id: `title-${c.id}`,
      name: c.title || "Title",
      type: "video",
      source: "upload",
      url: "",
    });
  return { tracks, media, clips };
}
