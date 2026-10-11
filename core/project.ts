import { z } from "zod";
export const Id = z.uuid();
const frame = z.number().int().min(0).max(18000);
export const AssetSchema = z
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
      .max(50 * 1024 * 1024),
    durationFrames: frame,
    width: z.number().int().min(0).max(4096),
    height: z.number().int().min(0).max(4096),
  })
  .strict();
export const TrackSchema = z
  .object({
    id: Id,
    name: z.string().min(1).max(80),
    kind: z.enum(["video", "audio"]),
    muted: z.boolean(),
    locked: z.boolean(),
    solo: z.boolean().optional(),
    targeted: z.boolean().optional(),
  })
  .strict();
export const ClipSchema = z
  .object({
    id: Id,
    trackId: Id,
    assetId: Id.nullable(),
    startFrame: frame,
    durationFrames: frame.min(1),
    sourceFrame: frame,
    title: z.string().max(500).nullable(),
  })
  .strict();
const SceneSchema = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    referenceAssetId: Id.nullable(),
    camera: z
      .object({
        focalLengthMm: z.number().min(8).max(300),
        shotScale: z.enum(["wide", "medium", "close"]),
        movement: z.enum(["static", "dolly", "pan", "orbit"]),
      })
      .strict(),
  })
  .strict();
export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    name: z.string().min(1).max(120),
    revision: z.number().int().nonnegative(),
    fps: z.literal(30),
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
    assets: z.array(AssetSchema).max(200),
    scenes: z.array(SceneSchema).max(100),
    tracks: z.array(TrackSchema).max(16),
    clips: z.array(ClipSchema).max(200),
  })
  .strict()
  .superRefine((p, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = [
      p.id,
      ...p.assets.map((x) => x.id),
      ...p.scenes.map((x) => x.id),
      ...p.tracks.map((x) => x.id),
      ...p.clips.map((x) => x.id),
    ];
    if (new Set(ids).size !== ids.length) fail("Identifiers must be unique.");
    for (const s of p.scenes)
      if (
        s.referenceAssetId &&
        !p.assets.some((a) => a.id === s.referenceAssetId && a.kind === "image")
      )
        fail("Scene reference must identify an imported image.");
    for (const c of p.clips) {
      const track = p.tracks.find((t) => t.id === c.trackId);
      const asset = p.assets.find((a) => a.id === c.assetId);
      if (!track) fail("Clip track is missing.");
      if (c.startFrame + c.durationFrames > 18000)
        fail("Timeline exceeds ten minutes.");
      if (c.title !== null) {
        if (c.assetId !== null || track?.kind !== "video")
          fail("Title requires a video track and no asset.");
      } else if (!asset) fail("Clip asset is missing.");
      else {
        if ((asset.kind === "audio") !== (track?.kind === "audio"))
          fail("Asset and track types do not match.");
        if (
          asset.kind !== "image" &&
          c.sourceFrame + c.durationFrames > asset.durationFrames
        )
          fail("Clip extends beyond its source.");
      }
    }
  });
export type Project = z.infer<typeof ProjectSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export function createProject(name: string): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    revision: 0,
    fps: 30,
    width: 1280,
    height: 720,
    assets: [],
    scenes: [],
    tracks: [
      {
        id: crypto.randomUUID(),
        name: "Picture",
        kind: "video",
        muted: false,
        locked: false,
      },
      {
        id: crypto.randomUUID(),
        name: "Audio",
        kind: "audio",
        muted: false,
        locked: false,
      },
    ],
    clips: [],
  });
}
