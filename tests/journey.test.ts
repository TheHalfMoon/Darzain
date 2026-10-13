// MVP journey steps 3 and 4 (docs/E2E_ACCEPTANCE.md): MP3 import with its
// probe and content hash, and three scenes with ordered shots referencing
// media that survive a reopen in order.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { canonicalJson } from "../core/donors/ninerr/canonical.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";

const bases: string[] = [];
after(async () => {
  closeWorkers();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function workspace() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-journey-"));
  bases.push(base);
  const root = path.join(base, "workspace");
  const store = new ProjectStore(root);
  await store.initialize();
  return { base, root, store };
}
// A media file made by FFmpeg from built-in test sources.
function make(dir: string, name: string, args: string[]) {
  const file = path.join(dir, name);
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args, file],
    { windowsHide: true },
  );
  return readFile(file);
}

test("an MP3 imports as audio with its probe and content hash, and is served unchanged", async () => {
  const { base, store } = await workspace();
  const project = await store.create("MP3 import");
  const bytes = await make(base, "tone.mp3", [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
  ]);
  const { asset, probe } = await store.importAsset(
    project.id,
    "tone.mp3",
    bytes,
  );
  assert.equal(asset.kind, "audio");
  assert.equal(asset.extension, "mp3");
  assert.equal(asset.hash, sha256(bytes));
  assert.equal(asset.bytes, bytes.length);
  // Two seconds at 30 frames per second, within the encoder's padding.
  assert.ok(
    Math.abs(asset.durationFrames - 60) <= 2,
    `${asset.durationFrames} frames`,
  );
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.hasVideo, false);
  const served = await store.assetFile(project.id, asset.id);
  assert.equal(sha256(await readFile(served.file)), asset.hash);
  store.close();
});

test("three scenes with ordered shots referencing media survive a reopen in order", async () => {
  const { base, root, store } = await workspace();
  const created = await store.create("Three scenes");
  const still = await store.importAsset(
    created.id,
    "board.png",
    await make(base, "board.png", [
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=320x180",
      "-frames:v",
      "1",
    ]),
  );
  const video = await store.importAsset(
    created.id,
    "take.mp4",
    await make(base, "take.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-pix_fmt",
      "yuv420p",
    ]),
  );
  const music = await store.importAsset(
    created.id,
    "music.mp3",
    await make(base, "music.mp3", [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libmp3lame",
    ]),
  );
  const head = await store.load(created.id);
  const picture = randomUUID();
  const sound = randomUUID();
  const clip = (trackId: string, assetId: string, startFrame: number) => ({
    id: randomUUID(),
    trackId,
    assetId,
    startFrame,
    durationFrames: 30,
    sourceFrame: 0,
    title: null,
  });
  const clips = [
    clip(picture, still.asset.id, 0),
    clip(picture, video.asset.id, 30),
    clip(picture, video.asset.id, 60),
    clip(sound, music.asset.id, 0),
    // A clip belongs to at most one shot: the last scene has its own.
    clip(picture, video.asset.id, 90),
    clip(picture, video.asset.id, 120),
    clip(picture, still.asset.id, 150),
  ];
  const shot = (name: string, clipIds: string[]) => ({
    id: randomUUID(),
    name,
    clipIds,
  });
  const camera = (
    shotScale: "wide" | "medium" | "close",
    focalLengthMm: number,
  ) => ({ focalLengthMm, shotScale, movement: "static" as const });
  const scenes = [
    {
      id: randomUUID(),
      name: "Arrival",
      referenceAssetId: still.asset.id,
      camera: camera("wide", 24),
      shots: [
        shot("Establishing", [clips[0].id]),
        shot("Walk in", [clips[1].id]),
      ],
    },
    {
      id: randomUUID(),
      name: "Conversation",
      referenceAssetId: null,
      camera: camera("medium", 50),
      shots: [shot("Two-shot", [clips[2].id, clips[3].id])],
    },
    {
      id: randomUUID(),
      name: "Departure",
      referenceAssetId: still.asset.id,
      camera: camera("close", 85),
      shots: [
        shot("Reaction", [clips[4].id]),
        shot("Exit", [clips[5].id]),
        shot("Card", [clips[6].id]),
      ],
    },
  ];
  await store.save(
    {
      ...head,
      tracks: [
        {
          id: picture,
          name: "Picture",
          kind: "video",
          muted: false,
          locked: false,
        },
        {
          id: sound,
          name: "Audio",
          kind: "audio",
          muted: false,
          locked: false,
        },
      ],
      clips,
      scenes,
    },
    head.revision,
  );
  const exported = canonicalJson(await store.exportProject(created.id));
  store.close();
  closeWorkers();

  // Reopen from the database alone.
  const reopened = new ProjectStore(root);
  await reopened.initialize();
  const project = await reopened.load(created.id);
  assert.deepEqual(
    project.scenes.map((s) => s.name),
    ["Arrival", "Conversation", "Departure"],
  );
  assert.deepEqual(
    project.scenes.map((s) => (s.shots ?? []).map((x) => x.name)),
    [["Establishing", "Walk in"], ["Two-shot"], ["Reaction", "Exit", "Card"]],
  );
  assert.deepEqual(
    project.scenes.map((s) => (s.shots ?? []).map((x) => x.clipIds)),
    scenes.map((s) => s.shots.map((x) => x.clipIds)),
  );
  assert.deepEqual(
    project.scenes.map((s) => [s.referenceAssetId, s.camera.shotScale]),
    [
      [still.asset.id, "wide"],
      [null, "medium"],
      [still.asset.id, "close"],
    ],
  );
  // Every shot's clip still points at the media version it was made from.
  const byId = new Map(project.clips.map((c) => [c.id, c]));
  for (const s of project.scenes)
    for (const x of s.shots ?? [])
      for (const id of x.clipIds)
        assert.ok(
          project.assets.some((a) => a.id === byId.get(id)?.assetId),
          `${s.name}/${x.name}`,
        );
  for (const a of [still.asset, video.asset, music.asset])
    assert.equal(
      project.assets.find((x) => x.id === a.id)?.hash,
      a.hash,
      a.name,
    );
  // The canonical project is byte-identical after the reopen.
  assert.equal(
    canonicalJson(await reopened.exportProject(created.id)),
    exported,
  );
  reopened.close();
});
