import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { renderRevision } from "../core/render.ts";
import { preview, evictPreviews } from "../core/render/preview.ts";
import { probe } from "../core/media.ts";
import { mediaTools } from "../core/process/workers.ts";
import { CommandError } from "../core/command/errors.ts";

const W = 320;
const H = 180;

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      windowsHide: true,
    },
  );

// A 4-second timeline: moving test video for 3 s on the picture track, a
// tone on the audio track, and a title on frames 45–74.
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-preview-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Preview");
  const mp4 = path.join(root, "src.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=30:duration=4`,
    "-pix_fmt",
    "yuv420p",
    mp4,
  ]);
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", wav]);
  const video = (
    await store.importAsset(created.id, "src.mp4", await readFile(mp4))
  ).asset;
  const { project, asset: tone } = await store.importAsset(
    created.id,
    "tone.wav",
    await readFile(wav),
  );
  const titles = crypto.randomUUID();
  const saved = await store.save(
    {
      ...project,
      width: W,
      height: H,
      tracks: [
        ...project.tracks,
        {
          id: titles,
          name: "Titles",
          kind: "video",
          muted: false,
          locked: false,
        },
      ],
      clips: [
        {
          id: crypto.randomUUID(),
          trackId: project.tracks[0].id,
          assetId: video.id,
          startFrame: 0,
          durationFrames: 90,
          sourceFrame: 15,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: project.tracks[1].id,
          assetId: tone.id,
          startFrame: 0,
          durationFrames: 120,
          sourceFrame: 0,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: titles,
          assetId: null,
          startFrame: 45,
          durationFrames: 30,
          sourceFrame: 0,
          title: "WWWW",
        },
      ],
    },
    project.revision,
  );
  return { root, store, project: saved };
}

const gray = (file: string) =>
  spawnSync(
    mediaTools().ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  ).stdout as Buffer;
function psnr(a: Buffer, b: Buffer) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  const mse = sum / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

test("a reference preview frame matches the export's frame at the same profile", async () => {
  const { root, store, project } = await workspace();
  try {
    const exported = await renderRevision(
      store,
      project.id,
      project.revision,
      ["exports", "parity"],
      new AbortController().signal,
      () => {},
    );
    for (const frame of [0, 50, 100]) {
      const shown = await preview(
        store,
        project.id,
        project.revision,
        "frame",
        frame,
      );
      assert.equal(shown.planHash, exported.plan.planHash, "same plan");
      const fromExport = path.join(root, `export-${frame}.png`);
      ffmpeg([
        "-i",
        exported.output,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        fromExport,
      ]);
      const score = psnr(gray(shown.file), gray(fromExport));
      assert.ok(score > 35, `frame ${frame}: ${score.toFixed(1)} dB`);
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a preview frame is cached by plan, window and engine, and shows titles on their exact frames", async () => {
  const { root, store, project } = await workspace();
  try {
    const first = await preview(
      store,
      project.id,
      project.revision,
      "frame",
      45,
    );
    assert.equal(first.cached, false);
    assert.equal(first.contentType, "image/png");
    const again = await preview(
      store,
      project.id,
      project.revision,
      "frame",
      45,
    );
    assert.equal(again.cached, true);
    assert.equal(again.file, first.file);
    const meta = await probe(first.file);
    assert.deepEqual([meta.width, meta.height], [W, H]);
    // The title starts on frame 45: frame 44 differs from 45 by the title.
    const before = await preview(
      store,
      project.id,
      project.revision,
      "frame",
      44,
    );
    assert.notEqual(before.file, first.file);
    // A new revision is a new plan and a new cache entry.
    const view = await store.load(project.id);
    const renamed = await store.save(
      {
        ...view,
        clips: view.clips.map((c) =>
          c.title === "WWWW" ? { ...c, title: "MMMM" } : c,
        ),
      },
      view.revision,
    );
    const changed = await preview(
      store,
      renamed.id,
      renamed.revision,
      "frame",
      45,
    );
    assert.notEqual(changed.planHash, first.planHash);
    assert.notEqual(changed.file, first.file);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a preview segment is a short MP4 with the window's picture and sound", async () => {
  const { root, store, project } = await workspace();
  try {
    const segment = await preview(
      store,
      project.id,
      project.revision,
      "segment",
      30,
      60,
    );
    assert.equal(segment.contentType, "video/mp4");
    const meta = await probe(segment.file);
    assert.ok(meta.hasVideo && meta.hasAudio);
    assert.ok(
      Math.abs(meta.durationFrames - 60) <= 2,
      String(meta.durationFrames),
    );
    // A segment past the end is clamped to the timeline.
    const tail = await preview(
      store,
      project.id,
      project.revision,
      "segment",
      100,
      60,
    );
    assert.ok(Math.abs((await probe(tail.file)).durationFrames - 20) <= 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("previews refuse windows outside the timeline or beyond the segment limit", async () => {
  const { root, store, project } = await workspace();
  try {
    for (const [kind, start, frames] of [
      ["frame", 120, 1],
      ["frame", -1, 1],
      ["frame", 0, 2],
      ["segment", 0, 151],
      ["segment", 1.5, 10],
    ] as const)
      await assert.rejects(
        preview(store, project.id, project.revision, kind, start, frames),
        (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
        `${kind} ${start} ${frames}`,
      );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the preview cache evicts least recently used entries above its bound, keeping recent ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-preview-cache-"));
  try {
    await mkdir(dir, { recursive: true });
    const names = ["a", "b", "c", "d"].map((c) =>
      path.join(dir, `${c.repeat(64)}.png`),
    );
    for (const [i, file] of names.entries()) {
      await writeFile(file, Buffer.alloc(1000));
      const t = new Date(Date.now() - (10 - i) * 60_000);
      await utimes(file, t, t);
    }
    // d was used just now: pinned.
    const now = new Date();
    await utimes(names[3], now, now);
    await evictPreviews(dir, names[2], 2000, 60_000);
    const left = await Promise.all(
      names.map((f) =>
        stat(f).then(
          () => true,
          () => false,
        ),
      ),
    );
    assert.deepEqual(left, [false, false, true, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
