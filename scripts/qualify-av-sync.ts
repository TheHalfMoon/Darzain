// A/V synchronisation over a ten-minute export (docs/E2E_ACCEPTANCE.md step
// 8: "audio onset within 20 ms and no accumulating drift on a 10-minute
// fixture"). The source is 600 s of 29.97 fps (30000/1001) video with
// 44.1 kHz audio: every 10 s one white flash frame and a 10 ms click mark
// the same instant. It is imported, cut into two clips at 300 s (the second
// continuing the source), exported at 30 fps / 48 kHz, and every flash and
// click is located in the export. Each click must sit within 20 ms of its
// instant and each flash within one frame of it, at the start, every
// intermediate mark and the end; the spread between the first and last
// offsets (accumulated drift) must stay within 5 ms of audio and one frame
// of video. Thresholds are locked here; a breach fails the run. It runs only
// on a clean tree, so the recorded commit is the code measured.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, tmpdir, totalmem } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import { clickTimes } from "../tests/fixtures/golden.ts";

const LIMITS = Object.freeze({
  clickOffsetMs: 20,
  audioDriftMs: 5,
  flashOffsetFrames: 1,
  videoDriftFrames: 1,
});
const RECEIPT = "docs/evidence/qualification/av-sync.json";
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ".", `:!${RECEIPT}`);
if (dirty)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);

const ffmpeg = (args: string[], maxBuffer = 256 * 1024 * 1024) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true, maxBuffer },
  );
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const root = await mkdtemp(path.join(tmpdir(), "yamakan-avsync-"));
let receipt: Record<string, unknown>;
try {
  const source = path.join(root, "sync-600s.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202020:s=640x360:r=30000/1001:d=600,drawbox=x=0:y=0:w=640:h=360:color=white:t=fill:enable='lt(mod(t\\,10)\\,0.03)'",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(lt(mod(t\\,10)\\,0.01)\\,0.8*sin(2*PI*1000*t)\\,0)':s=44100:d=600",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const sourceBytes = await readFile(source);

  const store = new ProjectStore(path.join(root, "workspace"));
  await store.initialize();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const created = await store.create("A/V sync");
  const imported = await store.importAsset(
    created.id,
    "sync-600s.mp4",
    sourceBytes,
  );
  const head = await store.load(created.id);
  const asset = imported.asset;
  const [picture, sound] = head.tracks;
  const half = 9000;
  const total = Math.min(asset.durationFrames, 18000);
  const clip = (
    trackId: string,
    startFrame: number,
    durationFrames: number,
  ) => ({
    id: crypto.randomUUID(),
    trackId,
    assetId: asset.id,
    startFrame,
    durationFrames,
    sourceFrame: startFrame,
    title: null,
  });
  await store.save(
    {
      ...head,
      width: 640,
      height: 360,
      clips: [
        clip(picture.id, 0, half),
        clip(picture.id, half, total - half),
        clip(sound.id, 0, half),
        clip(sound.id, half, total - half),
      ],
    },
    head.revision,
  );
  const started = performance.now();
  const job = await supervisor.submit(created.id, "av-sync");
  let status = supervisor.status(job.id);
  while (!["COMPLETED", "FAILED", "CANCELLED"].includes(status.state)) {
    await new Promise((r) => setTimeout(r, 250));
    status = supervisor.status(job.id);
  }
  const exportSeconds = (performance.now() - started) / 1000;
  if (status.state !== "COMPLETED")
    throw new Error(`Export ${status.state}: ${status.error}`);
  const file = await store.file(created.id, status.artifact!);
  const exported = await readFile(file);
  await supervisor.close();
  store.close();
  closeWorkers();

  // Flash frames: mean luma per frame of a downscaled decode.
  const luma = ffmpeg([
    "-i",
    file,
    "-vf",
    "scale=16:9,format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  const frameCount = luma.length / (16 * 9);
  const flashes: number[] = [];
  for (let n = 0; n < frameCount; n++) {
    let sum = 0;
    for (let i = 0; i < 144; i++) sum += luma[n * 144 + i];
    const bright = sum / 144 > 128;
    let previous = false;
    if (n > 0) {
      let s = 0;
      for (let i = 0; i < 144; i++) s += luma[(n - 1) * 144 + i];
      previous = s / 144 > 128;
    }
    if (bright && !previous) flashes.push(n);
  }
  const clicks = clickTimes(file);
  const marks = Math.floor(total / 300);
  const rows = [];
  for (let k = 0; k < marks; k++) {
    const instant = k * 10;
    const click = clicks.find((t) => Math.abs(t - instant) < 1);
    const flash = flashes.find((n) => Math.abs(n / 30 - instant) < 1);
    rows.push({
      mark: k,
      instantSeconds: instant,
      clickOffsetMs:
        click === undefined
          ? null
          : Number(((click - instant) * 1000).toFixed(2)),
      flashOffsetFrames: flash === undefined ? null : flash - instant * 30,
    });
  }
  const audio = rows.map((r) => r.clickOffsetMs);
  const video = rows.map((r) => r.flashOffsetFrames);
  const present = (xs: (number | null)[]) => xs.every((x) => x !== null);
  const a = audio as number[];
  const v = video as number[];
  const checks = [
    {
      check: "every mark has a click and a flash",
      measured: `${audio.filter((x) => x !== null).length}/${marks} clicks, ${video.filter((x) => x !== null).length}/${marks} flashes`,
      metThreshold: present(audio) && present(video) && marks === 60,
    },
    {
      check: `every click within ${LIMITS.clickOffsetMs} ms of its instant`,
      measured: present(audio) ? Math.max(...a.map(Math.abs)) : null,
      metThreshold:
        present(audio) && a.every((x) => Math.abs(x) <= LIMITS.clickOffsetMs),
    },
    {
      check: `audio drift (last minus first offset) within ${LIMITS.audioDriftMs} ms`,
      measured: present(audio) ? Number((a.at(-1)! - a[0]).toFixed(2)) : null,
      metThreshold:
        present(audio) && Math.abs(a.at(-1)! - a[0]) <= LIMITS.audioDriftMs,
    },
    {
      check: `every flash within ${LIMITS.flashOffsetFrames} frame of its instant`,
      measured: present(video) ? Math.max(...v.map(Math.abs)) : null,
      metThreshold:
        present(video) &&
        v.every((x) => Math.abs(x) <= LIMITS.flashOffsetFrames),
    },
    {
      check: `video drift (last minus first offset) within ${LIMITS.videoDriftFrames} frame`,
      measured: present(video) ? v.at(-1)! - v[0] : null,
      metThreshold:
        present(video) && Math.abs(v.at(-1)! - v[0]) <= LIMITS.videoDriftFrames,
    },
  ];
  receipt = {
    receipt: "yamakan.av-sync-qualification/1",
    commit: git("rev-parse", "HEAD"),
    measuredAt: new Date().toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      ffmpegSha256: sha256(await readFile(mediaTools().ffmpeg)),
    },
    fixture: {
      description:
        "600 s, 640x360, 30000/1001 fps H.264 with 44.1 kHz AAC; a white flash frame and a 10 ms 1 kHz click every 10 s; cut into two clips at 300 s; exported at 30 fps, 48 kHz",
      sourceSha256: sha256(sourceBytes),
      exportSha256: sha256(exported),
      exportSeconds: Math.round(exportSeconds * 10) / 10,
      exportFrames: frameCount,
    },
    limits: LIMITS,
    marks: rows,
    checks,
    passed: checks.every((c) => c.metThreshold),
  };
} finally {
  closeWorkers();
  // Never hides the run's own error.
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify({ checks: receipt.checks, passed: receipt.passed }, null, 2),
);
if (!receipt.passed) process.exitCode = 1;
