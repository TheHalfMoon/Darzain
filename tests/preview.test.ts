import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { renderRevision } from "../core/render.ts";
import {
  evictPreviews,
  preview,
  previewsWaiting,
} from "../core/render/preview.ts";
import { probe } from "../core/media.ts";
import { mediaTools } from "../core/process/workers.ts";
import { CommandError } from "../core/command/errors.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";

// Tests remove their own folders; these catch what a failed setup leaves,
// after its store closes (Windows cannot delete an open database).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});

const W = 320;
const H = 180;

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );

// A 4-second source at `rate` used by two adjacent clips: A shows source
// 0.5–2.0 s on timeline frames 0–44; B shows source 2.5 s to the source's
// end on frames 45–89 (ending exactly at the source's end). A tone plays
// throughout and a title covers frames 45–74 on its own track.
async function workspace(rate = "30") {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-preview-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  await store.initialize();
  const created = await store.create("Preview");
  const mp4 = path.join(root, "src.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${W}x${H}:rate=${rate}:duration=4`,
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
          durationFrames: 45,
          sourceFrame: 15,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: project.tracks[0].id,
          assetId: video.id,
          startFrame: 45,
          durationFrames: video.durationFrames - 75,
          sourceFrame: 75,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: project.tracks[1].id,
          assetId: tone.id,
          startFrame: 0,
          durationFrames: 90,
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

const BS = String.fromCharCode(92);
// Frame `n` of a video (or the only frame of an image) as grayscale pixels.
const gray = (file: string, n?: number) =>
  spawnSync(
    mediaTools().ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      ...(n === undefined ? [] : ["-vf", `select=eq(n${BS},${n})`]),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  ).stdout as Buffer;
function psnr(a: Buffer, b: Buffer) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  const mse = sum / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

for (const rate of ["30", "25", "24000/1001"])
  test(`reference frames match the export's frames at boundaries (${rate} fps source)`, async () => {
    const { root, store, project } = await workspace(rate);
    try {
      const exported = await renderRevision(
        store,
        project.id,
        project.revision,
        ["exports", "parity"],
        new AbortController().signal,
        () => {},
      );
      // Control: one frame apart scores far below the threshold, so a
      // one-frame error fails.
      assert.ok(
        psnr(gray(exported.output, 20), gray(exported.output, 21)) < 30,
      );
      for (const frame of [0, 20, 31, 39, 44, 45, 59, 74, 75, 89]) {
        const shown = await preview(
          store,
          project.id,
          project.revision,
          "frame",
          frame,
        );
        assert.equal(shown.planHash, exported.plan.planHash, "same plan");
        const score = psnr(gray(shown.file), gray(exported.output, frame));
        assert.ok(score > 35, `frame ${frame}: ${score.toFixed(1)} dB`);
      }
      // A segment: its first, middle and last frames are the export's.
      const segment = await preview(
        store,
        project.id,
        project.revision,
        "segment",
        25,
        40,
      );
      for (const [i, frame] of [
        [0, 25],
        [20, 45],
        [39, 64],
      ])
        assert.ok(
          psnr(gray(segment.file, i), gray(exported.output, frame)) > 35,
          `segment frame ${i}`,
        );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

test("titles appear and leave on their exact frames in the reference preview", async () => {
  const { root, store, project } = await workspace();
  try {
    // The same timeline without its title: frames differ exactly where the
    // title is shown.
    const view = await store.load(project.id);
    const untitled = await store.save(
      { ...view, clips: view.clips.filter((c) => c.title === null) },
      view.revision,
    );
    const differs = async (frame: number) =>
      psnr(
        gray(
          (await preview(store, project.id, project.revision, "frame", frame))
            .file,
        ),
        gray(
          (await preview(store, untitled.id, untitled.revision, "frame", frame))
            .file,
        ),
      ) !== Infinity;
    assert.deepEqual(await Promise.all([44, 45, 74, 75].map(differs)), [
      false,
      true,
      true,
      false,
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("previews are cached by plan and window, clamped to the saved timeline", async () => {
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
    assert.deepEqual(
      [(await probe(first.file)).width, (await probe(first.file)).height],
      [W, H],
    );
    // Past the end: the saved timeline's last frame.
    const past = await preview(
      store,
      project.id,
      project.revision,
      "frame",
      500,
    );
    assert.equal(past.startFrame, 89);
    assert.equal(
      past.file,
      (await preview(store, project.id, project.revision, "frame", 89)).file,
    );
    // A segment past the end is clamped.
    const tail = await preview(
      store,
      project.id,
      project.revision,
      "segment",
      70,
      60,
    );
    assert.equal(tail.frames, 20);
    const meta = await probe(tail.file);
    assert.ok(meta.hasVideo && meta.hasAudio);
    assert.ok(
      Math.abs(meta.durationFrames - 20) <= 2,
      String(meta.durationFrames),
    );
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
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("waiting previews are bounded, and an abandoned request does not render", async () => {
  const { root, store, project } = await workspace();
  try {
    const depth = RESOURCE_POLICY.enforced.previewQueueDepth;
    // Requests that leave before their turn: nothing is rendered for them.
    const leaving = new AbortController();
    // One running and `depth` waiting.
    const abandoned = Array.from({ length: depth + 1 }, (_, i) =>
      preview(
        store,
        project.id,
        project.revision,
        "segment",
        i * 5,
        40,
        leaving.signal,
      ).then(
        () => "rendered",
        (e: unknown) => (e instanceof CommandError ? e.code : "cancelled"),
      ),
    );
    for (let t = 0; t < 30000 && previewsWaiting() < depth; t += 20)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(previewsWaiting(), depth);
    // The queue is full: one more is refused as BUSY.
    await assert.rejects(
      preview(store, project.id, project.revision, "segment", 60, 20),
      (e: unknown) =>
        e instanceof CommandError && e.code === "BUSY" && e.retryable,
    );
    leaving.abort();
    const outcomes = await Promise.all(abandoned);
    assert.ok(
      outcomes.every((o) => o === "cancelled"),
      outcomes.join(","),
    );
    const cache = await store.file(project.id, "cache", "preview");
    const files = (await readdir(cache)).filter((n) => n.endsWith(".mp4"));
    assert.ok(files.length <= 1, `rendered ${files.length} abandoned segments`);
    // The queue drains: a new request renders normally.
    assert.equal(
      (await preview(store, project.id, project.revision, "frame", 10)).cached,
      false,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("previews refuse invalid windows and segments beyond the limit", async () => {
  const { root, store, project } = await workspace();
  try {
    for (const [kind, start, frames] of [
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
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the preview cache evicts least recently used entries; recency never holds it above twice its bound", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-preview-cache-"));
  bases.push(dir);
  try {
    await mkdir(dir, { recursive: true });
    const names = ["a", "b", "c", "d"].map((c) =>
      path.join(dir, `${c.repeat(64)}.png`),
    );
    const touch = async (file: string, minutesAgo: number) => {
      const t = new Date(Date.now() - minutesAgo * 60_000);
      await utimes(file, t, t);
    };
    for (const [i, file] of names.entries()) {
      await writeFile(file, Buffer.alloc(1000));
      await touch(file, 10 - i);
    }
    // d was used just now: kept while under twice the bound.
    await touch(names[3], 0);
    await evictPreviews(dir, names[2], 2000, 60_000);
    const exists = (f: string) =>
      stat(f).then(
        () => true,
        () => false,
      );
    assert.deepEqual(await Promise.all(names.map(exists)), [
      false,
      false,
      true,
      true,
    ]);
    // Six recent entries (all "pinned") against a 1000-byte bound: recency
    // stops protecting them above 2000 bytes.
    const recent = ["0", "1", "2", "3", "4", "5"].map((c) =>
      path.join(dir, `${c.repeat(64)}.png`),
    );
    for (const file of recent) await writeFile(file, Buffer.alloc(1000));
    await evictPreviews(dir, recent[5], 1000, 60_000);
    let total = 0;
    for (const name of await readdir(dir))
      total += (await stat(path.join(dir, name))).size;
    assert.ok(total <= 2000, String(total));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clips show picture on their first frame when the source start falls inside a source frame or a still starts off the 1/25 s grid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-preview-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  try {
    await store.initialize();
    const created = await store.create("First frames");
    const mp4 = path.join(root, "src25.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${W}x${H}:rate=25:duration=4`,
      "-pix_fmt",
      "yuv420p",
      mp4,
    ]);
    const png = path.join(root, "still.png");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${W}x${H}`,
      "-frames:v",
      "1",
      png,
    ]);
    const video = (
      await store.importAsset(created.id, "src25.mp4", await readFile(mp4))
    ).asset;
    const { project, asset: still } = await store.importAsset(
      created.id,
      "still.png",
      await readFile(png),
    );
    const track = project.tracks[0].id;
    const saved = await store.save(
      {
        ...project,
        width: W,
        height: H,
        clips: [
          // Source starts 5 and 71 (in 30 fps units) fall inside 25 fps frames.
          {
            id: crypto.randomUUID(),
            trackId: track,
            assetId: video.id,
            startFrame: 0,
            durationFrames: 30,
            sourceFrame: 5,
            title: null,
          },
          {
            id: crypto.randomUUID(),
            trackId: track,
            assetId: video.id,
            startFrame: 30,
            durationFrames: 30,
            sourceFrame: 71,
            title: null,
          },
          // A still starting on frame 63 (2.1 s, off the 1/25 s grid).
          {
            id: crypto.randomUUID(),
            trackId: track,
            assetId: still.id,
            startFrame: 63,
            durationFrames: 12,
            sourceFrame: 0,
            title: null,
          },
        ],
      },
      project.revision,
    );
    const exported = await renderRevision(
      store,
      saved.id,
      saved.revision,
      ["exports", "first"],
      new AbortController().signal,
      () => {},
    );
    const mean = (pixels: Buffer) =>
      pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
    // Control: the gap before the still (frames 60–62) is black.
    assert.ok(mean(gray(exported.output, 61)) < 5, "gap is black");
    for (const frame of [0, 30, 63, 74]) {
      const fromExport = gray(exported.output, frame);
      assert.ok(mean(fromExport) > 40, `export frame ${frame} shows picture`);
      const shown = await preview(
        store,
        saved.id,
        saved.revision,
        "frame",
        frame,
      );
      assert.ok(
        psnr(gray(shown.file), fromExport) > 35,
        `preview frame ${frame}`,
      );
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
