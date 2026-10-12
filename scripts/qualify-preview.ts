// T8 reference-preview latency qualification. Builds a 30-second 1280x720
// timeline (moving video, audio, an Arabic/Latin title) and measures, on
// this machine: the very first frame (renderer start-up included), cold
// frames (cache misses), warm frames (cache hits) and cold 2-second
// segments. Targets are the plan's proposed ones (reference still ≤ 1 s
// warm, ≤ 3 s cold; 2 s segment ≤ 6 s cold); the receipt records measured
// values and whether each target was met, without adjusting either. It
// runs only on a clean tree, so the recorded commit is the code measured.
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { preview } from "../core/render/preview.ts";
import { mediaTools, closeWorkers } from "../core/process/workers.ts";

const RECEIPT = "docs/evidence/qualification/t8-preview.json";
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ".", `:!${RECEIPT}`);
if (dirty)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );
const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    runs: ms.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
  };
};
const timed = async (fn: () => Promise<unknown>) => {
  const started = performance.now();
  await fn();
  return performance.now() - started;
};

const root = await mkdtemp(path.join(tmpdir(), "yamakan-preview-qual-"));
try {
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Preview qualification");
  const media = path.join(root, "media");
  await mkdir(media);
  const video = path.join(media, "video.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30:duration=30",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    video,
  ]);
  const tone = path.join(media, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=30", tone]);
  const v = await store.importAsset(
    created.id,
    "video.mp4",
    await readFile(video),
  );
  const a = await store.importAsset(
    created.id,
    "tone.wav",
    await readFile(tone),
  );
  const titles = crypto.randomUUID();
  const saved = await store.save(
    {
      ...a.project,
      width: 1280,
      height: 720,
      tracks: [
        ...a.project.tracks,
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
          trackId: a.project.tracks[0].id,
          assetId: v.asset.id,
          startFrame: 0,
          durationFrames: 900,
          sourceFrame: 0,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: a.project.tracks[1].id,
          assetId: a.asset.id,
          startFrame: 0,
          durationFrames: 900,
          sourceFrame: 0,
          title: null,
        },
        {
          id: crypto.randomUUID(),
          trackId: titles,
          assetId: null,
          startFrame: 0,
          durationFrames: 900,
          sourceFrame: 0,
          title: "المشهد الأول · Opening scene",
        },
      ],
    },
    a.project.revision,
  );
  const frame = (n: number) =>
    preview(store, saved.id, saved.revision, "frame", n);
  const first = await timed(() => frame(450));
  const frames = [30, 120, 210, 300, 390, 510, 600, 690, 780, 870];
  const cold: number[] = [];
  for (const n of frames) cold.push(await timed(() => frame(n)));
  const warm: number[] = [];
  for (const n of frames) warm.push(await timed(() => frame(n)));
  const segments: number[] = [];
  for (const n of [0, 180, 360, 540, 720])
    segments.push(
      await timed(() =>
        preview(store, saved.id, saved.revision, "segment", n, 60),
      ),
    );
  const results = {
    firstFrameMs: Math.round(first),
    coldFrame: stats(cold),
    warmFrame: stats(warm),
    coldSegment2s: stats(segments),
  };
  const targets = {
    warmFrameP95Ms: { target: 1000, measured: results.warmFrame.p95 },
    coldFrameP95Ms: { target: 3000, measured: results.coldFrame.p95 },
    coldSegment2sP95Ms: { target: 6000, measured: results.coldSegment2s.p95 },
  };
  const report = {
    qualification: "t8-reference-preview-latency",
    date: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    host: {
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
    },
    ffmpeg: execFileSync(mediaTools().ffmpeg, ["-hide_banner", "-version"], {
      encoding: "utf8",
      windowsHide: true,
    }).split("\n")[0],
    fixture:
      "30 s 1280x720 timeline: FFmpeg test pattern (GOP 60), sine audio, one Arabic/Latin title for the whole duration",
    results,
    targets: Object.fromEntries(
      Object.entries(targets).map(([k, t]) => [
        k,
        { ...t, met: t.measured <= t.target },
      ]),
    ),
    note: "Targets are the plan's proposed values, measured on this host only; Profile A qualification (T10) repeats this on the reference hardware.",
  };
  await writeFile(RECEIPT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ results, targets: report.targets }, null, 2));
  store.close();
} finally {
  closeWorkers();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
