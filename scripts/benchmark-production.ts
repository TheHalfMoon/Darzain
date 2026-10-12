import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { ProjectStore } from "../core/store.ts";
import { renderRevision } from "../core/render.ts";
import { probe } from "../core/media.ts";
const root = await mkdtemp(path.join(tmpdir(), "darzain-benchmark-"));
const store = new ProjectStore(path.join(root, "workspace"));
await store.initialize();
const project = await store.create("30-second imported-media production");
const ffmpeg = process.env.DARZAIN_FFMPEG || "ffmpeg";
const run = (args: string[]) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    windowsHide: true,
  });
run([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360",
  "-frames:v",
  "1",
  "-threads",
  "1",
  path.join(root, "reference.png"),
]);
run([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=30:duration=10",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-threads",
  "2",
  "-pix_fmt",
  "yuv420p",
  path.join(root, "motion.mp4"),
]);
run([
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:duration=30",
  "-threads",
  "1",
  path.join(root, "music.wav"),
]);
const images = await store.importAsset(
  project.id,
  "reference.png",
  await readFile(path.join(root, "reference.png")),
);
const motion = await store.importAsset(
  project.id,
  "motion.mp4",
  await readFile(path.join(root, "motion.mp4")),
);
const sound = await store.importAsset(
  project.id,
  "music.wav",
  await readFile(path.join(root, "music.wav")),
);
const p = sound.project;
const titleTrack = {
  id: randomUUID(),
  name: "Titles",
  kind: "video" as const,
  muted: false,
  locked: false,
};
p.tracks.push(titleTrack);
for (let shot = 0; shot < 3; shot++) {
  p.scenes.push({
    id: randomUUID(),
    name: `Shot ${shot + 1}`,
    referenceAssetId: images.asset.id,
    camera: {
      focalLengthMm: [35, 50, 85][shot],
      shotScale: shot === 2 ? "close" : "medium",
      movement: "static",
    },
  });
  p.clips.push({
    id: randomUUID(),
    trackId: p.tracks[0].id,
    assetId: shot === 1 ? motion.asset.id : images.asset.id,
    startFrame: shot * 300,
    durationFrames: 300,
    sourceFrame: 0,
    title: null,
  });
  p.clips.push({
    id: randomUUID(),
    trackId: titleTrack.id,
    assetId: null,
    startFrame: shot * 300,
    durationFrames: 300,
    sourceFrame: 0,
    title: `Darzain | Shot ${shot + 1} | Test fixture`,
  });
}
p.clips.push({
  id: randomUUID(),
  trackId: p.tracks[1].id,
  assetId: sound.asset.id,
  startFrame: 0,
  durationFrames: 900,
  sourceFrame: 0,
  title: null,
});
const saved = await store.save(p, p.revision),
  jobId = randomUUID();
const started = performance.now();
const { output } = await renderRevision(
  store,
  saved.id,
  saved.revision,
  ["exports", jobId, "attempt-1"],
  new AbortController().signal,
  () => {},
);
const elapsedMs = Math.round(performance.now() - started);
const metadata = await probe(output),
  bytes = await readFile(output);
const second = new ProjectStore(store.root);
await second.initialize();
const reopened = await second.load(p.id);
second.close();
if (
  metadata.durationFrames !== 900 ||
  !metadata.hasAudio ||
  reopened.clips.length !== 7
)
  throw new Error("Benchmark production qualification failed.");
const dest = path.resolve(
  process.env.DARZAIN_BENCHMARK_OUTPUT || "work/benchmark",
);
await mkdir(dest, { recursive: true });
await writeFile(path.join(dest, "darzain-30-second-production.mp4"), bytes);
const receipt = {
  fixture:
    "FFmpeg test pattern, motion pattern and sine audio; not AI generation",
  resolution: [p.width, p.height],
  durationFrames: metadata.durationFrames,
  hasAudio: metadata.hasAudio,
  clipCount: reopened.clips.length,
  scenes: reopened.scenes.length,
  elapsedMs,
  artifactBytes: bytes.length,
  artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  hardware: {
    platform: process.platform,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1073741824),
  },
  cameraEffect: "shot intent metadata only",
};
await writeFile(
  path.join(dest, "receipt.json"),
  JSON.stringify(receipt, null, 2),
);
console.log(receipt);
store.close();
await rm(root, { recursive: true, force: true });
