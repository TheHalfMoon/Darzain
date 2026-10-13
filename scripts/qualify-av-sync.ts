// A/V synchronisation over a ten-minute export (docs/E2E_ACCEPTANCE.md step
// 8: "audio onset within 20 ms and no accumulating drift on a 10-minute
// fixture"). The sources are 599.9 s of 29.97 fps (30000/1001) video and
// 599.9 s of 44.1 kHz audio: every 10 s a white flash frame and a 10 ms
// click mark the same instant. Both are imported and cut into two clips at
// 300 s (the second continuing the source), exported at 30 fps / 48 kHz,
// and every flash and click is located in the export. Each click must sit
// within 20 ms of its instant and each flash within one frame of it, at the
// start, every intermediate mark and the end; accumulated drift (the mean
// offset of the last ten marks minus that of the first ten, so that a 29.97
// fps source's cycling one-frame phase is not mistaken for drift) must stay
// within 5 ms of audio and one frame of video. A negative control whose
// clicks repeat every 10.002 s (2 ms of drift per mark) must fail the same
// checks, or the run fails. Thresholds are locked here; a breach fails the
// run. It runs only on a clean tree, so the recorded commit is the code
// measured.
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
const CONTROL_CLICK_PERIOD = 10.002;
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

// One run: the flash marks every 10 s; the clicks every `clickPeriod`
// seconds (10 for the fixture, more for the negative control).
async function measure(clickPeriod: number) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-avsync-"));
  try {
    // Picture and sound as separate media, as the timeline carries them: a
    // video clip's own sound is not rendered (sound comes from sound-track
    // clips of audio assets).
    const videoFile = path.join(root, "flash-600s.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      // Exactly one flash per mark: the first source frame at or after each
      // 10 s instant (a frame lasts 1001/30000 s, so a time window could
      // miss or double it).
      "color=c=0x202020:s=640x360:r=30000/1001:d=599.9,drawbox=x=0:y=0:w=640:h=360:color=white:t=fill:enable='eq(n\\,ceil(floor(n*1001/300000)*300000/1001))'",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      videoFile,
    ]);
    const soundFile = path.join(root, "click-600s.wav");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='if(lt(mod(t\\,${clickPeriod})\\,0.01)\\,0.8*sin(2*PI*1000*t)\\,0)':s=44100:d=599.9`,
      soundFile,
    ]);
    const videoBytes = await readFile(videoFile);
    const audioBytes = await readFile(soundFile);

    const store = new ProjectStore(path.join(root, "workspace"));
    await store.initialize();
    const supervisor = new JobSupervisor(store);
    await supervisor.start();
    const created = await store.create("A/V sync");
    const picture = (
      await store.importAsset(created.id, "flash-600s.mp4", videoBytes)
    ).asset;
    const click = (
      await store.importAsset(created.id, "click-600s.wav", audioBytes)
    ).asset;
    const head = await store.load(created.id);
    const [pictureTrack, soundTrack] = head.tracks;
    const half = 9000;
    const total = Math.min(picture.durationFrames, click.durationFrames, 18000);
    // Two clips per track, cut at 300 s, the second continuing the source.
    const clip = (
      trackId: string,
      assetId: string,
      startFrame: number,
      durationFrames: number,
    ) => ({
      id: crypto.randomUUID(),
      trackId,
      assetId,
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
          clip(pictureTrack.id, picture.id, 0, half),
          clip(pictureTrack.id, picture.id, half, total - half),
          clip(soundTrack.id, click.id, 0, half),
          clip(soundTrack.id, click.id, half, total - half),
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
    const frameCount = luma.length / 144;
    const bright = (n: number) => {
      let sum = 0;
      for (let i = 0; i < 144; i++) sum += luma[n * 144 + i];
      return sum / 144 > 128;
    };
    const flashes: number[] = [];
    for (let n = 0; n < frameCount; n++)
      if (bright(n) && (n === 0 || !bright(n - 1))) flashes.push(n);
    const clicks = clickTimes(file);
    // One mark every 10 s (300 frames) from frame 0: 60 marks in 599.9 s.
    const marks = Math.floor((total - 1) / 300) + 1;
    const rows = [];
    for (let k = 0; k < marks; k++) {
      const instant = k * 10;
      const c = clicks.find((t) => Math.abs(t - instant) < 1);
      const flash = flashes.find((n) => Math.abs(n / 30 - instant) < 1);
      rows.push({
        mark: k,
        instantSeconds: instant,
        clickOffsetMs:
          c === undefined ? null : Number(((c - instant) * 1000).toFixed(2)),
        flashOffsetFrames: flash === undefined ? null : flash - instant * 30,
      });
    }
    const audio = rows.map((r) => r.clickOffsetMs);
    const video = rows.map((r) => r.flashOffsetFrames);
    const present = (xs: (number | null)[]) => xs.every((x) => x !== null);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const drift = (xs: number[]) => mean(xs.slice(-10)) - mean(xs.slice(0, 10));
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
        check: `audio drift (mean of the last ten offsets minus the first ten) within ${LIMITS.audioDriftMs} ms`,
        measured: present(audio) ? Number(drift(a).toFixed(2)) : null,
        metThreshold:
          present(audio) && Math.abs(drift(a)) <= LIMITS.audioDriftMs,
      },
      {
        check: `every flash within ${LIMITS.flashOffsetFrames} frame of its instant`,
        measured: present(video) ? Math.max(...v.map(Math.abs)) : null,
        metThreshold:
          present(video) &&
          v.every((x) => Math.abs(x) <= LIMITS.flashOffsetFrames),
      },
      {
        check: `video drift (mean of the last ten offsets minus the first ten) within ${LIMITS.videoDriftFrames} frame`,
        measured: present(video) ? Number(drift(v).toFixed(2)) : null,
        metThreshold:
          present(video) && Math.abs(drift(v)) <= LIMITS.videoDriftFrames,
      },
    ];
    return {
      fixture: {
        clickPeriodSeconds: clickPeriod,
        videoSha256: sha256(videoBytes),
        audioSha256: sha256(audioBytes),
        exportSha256: sha256(exported),
        exportSeconds: Math.round(exportSeconds * 10) / 10,
        exportFrames: frameCount,
      },
      marks: rows,
      checks,
      passed: checks.every((c) => c.metThreshold),
    };
  } finally {
    closeWorkers();
    // Never hides the run's own error.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const fixture = await measure(10);
const control = await measure(CONTROL_CLICK_PERIOD);
const receipt = {
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
  description:
    "599.9 s of 640x360 30000/1001 fps H.264 (a white flash frame every 10 s) and 599.9 s of 44.1 kHz WAV (a 10 ms 1 kHz click at the same instants), each cut into two clips at 300 s on the picture and sound tracks; exported at 30 fps, 48 kHz",
  limits: LIMITS,
  ...fixture,
  // The same run with clicks every 10.002 s must be caught.
  negativeControl: {
    ...control.fixture,
    checks: control.checks,
    detected: !control.passed,
  },
  passed: fixture.passed && !control.passed,
};
await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      checks: receipt.checks,
      negativeControlDetected: receipt.negativeControl.detected,
      passed: receipt.passed,
    },
    null,
    2,
  ),
);
if (!receipt.passed) process.exitCode = 1;
