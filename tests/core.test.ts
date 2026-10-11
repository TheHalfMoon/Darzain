import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectStore } from "../core/store.ts";
import { ProjectSchema } from "../core/project.ts";
import { renderProject, RenderQueue } from "../core/render.ts";
import { safePath } from "../core/paths.ts";
import { CreativeAPI } from "../server/api.ts";
import { canonicalJson } from "../core/donors/ninerr/canonical.ts";
const ffmpeg = process.env.DARZAIN_FFMPEG || "ffmpeg";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "darzain-test-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Cinematic product");
  return { root, store, project };
}
test("project import, scene, timeline, title, audio, render and reopen preserve an editable production", async () => {
  const { root, store, project } = await fixture();
  const png = path.join(root, "source.png"),
    audio = path.join(root, "source.wav");
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180",
      "-frames:v",
      "1",
      "-threads",
      "1",
      png,
    ],
    { windowsHide: true },
  );
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-threads",
      "1",
      audio,
    ],
    { windowsHide: true },
  );
  let result = await store.importAsset(
    project.id,
    "product.png",
    await readFile(png),
  );
  const picture = result.asset;
  result = await store.importAsset(
    project.id,
    "music.wav",
    await readFile(audio),
  );
  const sound = result.asset;
  const p = result.project;
  p.width = 320;
  p.height = 180;
  p.scenes.push({
    id: crypto.randomUUID(),
    name: "Product closeup",
    referenceAssetId: picture.id,
    camera: { focalLengthMm: 85, shotScale: "close", movement: "static" },
  });
  const titleTrack = {
    id: crypto.randomUUID(),
    name: "Titles",
    kind: "video" as const,
    muted: false,
    locked: false,
  };
  p.tracks.push(titleTrack);
  p.clips.push(
    {
      id: crypto.randomUUID(),
      trackId: p.tracks[0].id,
      assetId: picture.id,
      startFrame: 0,
      durationFrames: 90,
      sourceFrame: 0,
      title: null,
    },
    {
      id: crypto.randomUUID(),
      trackId: p.tracks[1].id,
      assetId: sound.id,
      startFrame: 0,
      durationFrames: 90,
      sourceFrame: 0,
      title: null,
    },
    {
      id: crypto.randomUUID(),
      trackId: titleTrack.id,
      assetId: null,
      startFrame: 0,
      durationFrames: 90,
      sourceFrame: 0,
      title: "Darzain 100%: product",
    },
  );
  const saved = await store.save(p, p.revision);
  const jobId = crypto.randomUUID();
  let progress = 0;
  const artifact = await renderProject(
    store,
    saved,
    jobId,
    new AbortController().signal,
    (n) => (progress = n),
  );
  assert.equal(progress, 1);
  assert.equal(artifact, `exports/${jobId}/render.mp4`);
  const out = await readFile(await store.file(p.id, ...artifact.split("/")));
  assert.ok(out.length > 1000);
  const reopened = await new ProjectStore(root).load(p.id);
  assert.deepEqual(reopened, saved);
  assert.equal(reopened.scenes[0].camera.focalLengthMm, 85);
  const api = new CreativeAPI(new ProjectStore(root));
  assert.deepEqual(
    await api.call("darzain.project.open", { projectId: p.id }),
    saved,
  );
});
test("revision conflicts prevent concurrent overwrite and immutable assets cannot be forged", async () => {
  const { store, project } = await fixture();
  const a = structuredClone(project),
    b = structuredClone(project);
  a.name = "First";
  b.name = "Second";
  const results = await Promise.allSettled([
    store.save(a, 0),
    store.save(b, 0),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.load(project.id)).revision, 1);
  const forged = await store.load(project.id);
  forged.assets.push({
    id: crypto.randomUUID(),
    name: "fake.png",
    kind: "image",
    hash: "a".repeat(64),
    extension: "png",
    bytes: 100,
    width: 100,
    height: 100,
    durationFrames: 0,
  });
  await assert.rejects(store.save(forged, 1), /Assets must/);
});
test("malicious paths, disguised playlists, schema versions and missing references fail closed", async () => {
  const { root, store, project } = await fixture();
  await assert.rejects(safePath(root, "../outside"), /escapes/);
  await assert.rejects(store.load("../outside"));
  await assert.rejects(
    store.importAsset(
      project.id,
      "video.mp4",
      Buffer.from("#EXTM3U\nfile:///secret"),
    ),
    /signature/,
  );
  assert.equal(
    ProjectSchema.safeParse({ ...project, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    ProjectSchema.safeParse({
      ...project,
      clips: [
        {
          id: crypto.randomUUID(),
          trackId: project.tracks[0].id,
          assetId: crypto.randomUUID(),
          startFrame: 0,
          durationFrames: 30,
          sourceFrame: 0,
          title: null,
        },
      ],
    }).success,
    false,
  );
  assert.throws(() => canonicalJson({ n: Infinity }));
  const outside = await mkdtemp(path.join(tmpdir(), "darzain-outside-"));
  await symlink(
    outside,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(safePath(root, "linked", "leak"), /Symbolic/);
});
test("corrupt asset or snapshot fails integrity validation without silent rewriting", async () => {
  const { store, project } = await fixture();
  const snapshot = await store.file(project.id, "snapshots", "0.json");
  await writeFile(snapshot, "{}");
  await assert.rejects(store.load(project.id), /hash mismatch/);
  assert.equal(await readFile(snapshot, "utf8"), "{}");
});
test("unknown tools and injected call keys are rejected", async () => {
  const { store, project } = await fixture();
  const api = new CreativeAPI(store);
  await assert.rejects(
    api.call("run_command", { cmd: "whoami" }),
    /Unknown operation/,
  );
  await assert.rejects(
    api.call("darzain.project.open", {
      projectId: project.id,
      filePath: "../outside",
    }),
  );
});
test("render queue submissions are idempotent and queued cancellation is terminal", async () => {
  const { store, project } = await fixture();
  const queue = new RenderQueue(store);
  const one = await queue.submit(project.id, "same");
  const two = await queue.submit(project.id, "same");
  assert.equal(one.id, two.id);
  const next = await queue.submit(project.id, "next");
  queue.cancel(next.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(queue.status(next.id).state, "CANCELLED");
});

test("cancellation during artifact publication leaves no completed output", async () => {
  const { store, project } = await fixture();
  project.width = 320;
  project.height = 180;
  project.clips.push({
    id: crypto.randomUUID(),
    trackId: project.tracks[0].id,
    assetId: null,
    startFrame: 0,
    durationFrames: 30,
    sourceFrame: 0,
    title: "Cancel publication",
  });
  const saved = await store.save(project, 0),
    controller = new AbortController(),
    jobId = crypto.randomUUID();
  const original = store.file.bind(store);
  store.file = async (...args: Parameters<typeof store.file>) => {
    const result = await original(...args);
    if (args.at(-1) === "render.mp4") controller.abort();
    return result;
  };
  await assert.rejects(
    renderProject(store, saved, jobId, controller.signal, () => {}),
    /Cancelled/,
  );
  await assert.rejects(
    access(await original(project.id, "exports", jobId, "render.mp4")),
  );
  await assert.rejects(
    access(await original(project.id, "exports", jobId, "render.partial.mp4")),
  );
});

test("queue closure rejects a submission whose project load finishes afterward", async () => {
  const { store, project } = await fixture();
  let release!: (value: typeof project) => void;
  store.load = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const queue = new RenderQueue(store),
    pending = queue.submit(project.id, "shutdown-race");
  await queue.close();
  release(project);
  await assert.rejects(pending, /closing/);
  assert.equal(queue.list().length, 0);
  await assert.rejects(queue.submit(project.id, "after-close"), /closing/);
});
