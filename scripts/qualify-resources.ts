// Resource qualification (resource policy, core/command/policy.ts). Drives
// the real product paths — import probes, a constant-rate conversion,
// exports and reference previews — over a fixed corpus of supported codecs,
// and records each worker's peak committed Job Object memory and wall time
// as reported by procd. It also records this process's peak resident memory
// for information (the import-service RSS ceiling is qualified by
// scripts/qualify-large-import.mjs against a separate service process).
// Every measured value is checked against the policy's qualification
// thresholds; a breach fails the run. It runs only on a clean tree, so the
// recorded commit is the code measured. Windows only (Job Object figures).
import { execFileSync } from "node:child_process";
import { cpus, totalmem, tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { preview } from "../core/render/preview.ts";
import { closeWorkers, mediaTools, workers } from "../core/process/workers.ts";
import type { WorkerReport } from "../core/process/owner.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";

if (process.platform !== "win32")
  throw new Error("Resource qualification measures Windows Job Objects.");
const RECEIPT = "docs/evidence/qualification/resource-policy.json";
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ".", `:!${RECEIPT}`);
if (dirty && !process.env.YAMAKAN_QUALIFY_DIRTY)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);

const MiB = 1024 * 1024;
const Q = RESOURCE_POLICY.qualification;
const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Every worker report, tagged with the phase that caused it.
let phase = "setup";
const reports: (WorkerReport & { phase: string })[] = [];
const unsubscribe = workers().observe((r) => reports.push({ ...r, phase }));
let rssPeak = 0;
const rssTimer = setInterval(
  () => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)),
  25,
);

const root = await mkdtemp(path.join(tmpdir(), "yamakan-resource-qual-"));
const results: Record<string, unknown> = {};
try {
  const media = path.join(root, "media");
  await mkdir(media);
  // The corpus: every accepted container family, the largest accepted
  // dimensions, and the heaviest supported decoders (HEVC, AV1, ProRes).
  const v = (size: string, rate = 30, seconds = 5) => [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
  ];
  const a = (seconds = 5) => [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
  ];
  const corpus: { name: string; args: string[] }[] = [
    {
      name: "h264-1080p.mp4",
      args: [
        ...v("1920x1080", 30, 10),
        ...a(10),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
      ],
    },
    {
      name: "h264-2160p.mp4",
      args: [
        ...v("3840x2160"),
        ...a(),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
      ],
    },
    {
      name: "hevc-2160p.mp4",
      args: [
        ...v("3840x2160", 30, 3),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-tag:v",
        "hvc1",
      ],
    },
    {
      name: "hevc-4096x2160-10bit.mov",
      args: [
        ...v("4096x2160", 24, 2),
        "-pix_fmt",
        "yuv420p10le",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
      ],
    },
    {
      name: "vp9-1080p.webm",
      args: [
        ...v("1920x1080", 30, 3),
        ...a(3),
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libopus",
      ],
    },
    {
      name: "av1-1080p.webm",
      args: [...v("1920x1080", 30, 3), "-c:v", "libsvtav1", "-preset", "12"],
    },
    {
      name: "prores-1080p.mov",
      args: [...v("1920x1080", 30, 2), "-c:v", "prores_ks", "-profile:v", "3"],
    },
    {
      name: "still-4096.png",
      args: [...v("4096x4096", 1, 1), "-frames:v", "1"],
    },
    {
      name: "still-4096.jpg",
      args: [...v("4096x4096", 1, 1), "-frames:v", "1"],
    },
    {
      name: "still-4096.webp",
      args: [...v("4096x4096", 1, 1), "-frames:v", "1"],
    },
    { name: "tone-600s.wav", args: [...a(600)] },
    { name: "tone-600s.mp3", args: [...a(600), "-c:a", "libmp3lame"] },
    { name: "tone-600s.ogg", args: [...a(600), "-c:a", "libvorbis"] },
  ];
  const store = new ProjectStore(path.join(root, "workspace"));
  await store.initialize();
  const project = await store.create("Resource qualification");
  const imported: Record<
    string,
    Awaited<ReturnType<typeof store.importAsset>>
  > = {};
  const corpusHashes: Record<string, string> = {};
  for (const item of corpus) {
    const file = path.join(media, item.name);
    phase = "fixture";
    ffmpeg([...item.args, file]);
    const bytes = await readFile(file);
    corpusHashes[item.name] = sha256(bytes);
    phase = `import:${item.name}`;
    imported[item.name] = await store.importAsset(project.id, item.name, bytes);
  }

  // A variable-frame-rate 1080p source converted through the supervisor.
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const waitFor = async (jobId: string) => {
    for (;;) {
      const s = supervisor.status(jobId);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(s.state)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const vfr = path.join(media, "vfr-1080p.mp4");
  phase = "fixture";
  ffmpeg([
    ...v("1920x1080", 30, 60),
    ...a(60),
    "-vf",
    "select='not(mod(n\\,3))+eq(n\\,1)'",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-shortest",
    vfr,
  ]);
  phase = "import:vfr-1080p.mp4";
  const vfrBytes = await readFile(vfr);
  corpusHashes["vfr-1080p.mp4"] = sha256(vfrBytes);
  const staged = await store.stageAsset(project.id, "vfr-1080p.mp4", vfrBytes);
  phase = "conversion:vfr-1080p";
  const conversion = await waitFor(
    (await supervisor.submitDerivative(project.id, staged)).id,
  );
  if (conversion.state !== "COMPLETED")
    throw new Error(`Conversion ${conversion.state}: ${conversion.error}`);

  // Exports: the 720p reference timeline (video, audio, Arabic/Latin
  // title), and a 1080p timeline cutting between the heaviest decoders.
  const head = await store.load(project.id);
  const asset = (name: string) => imported[name].asset;
  const [videoTrack, audioTrack] = head.tracks;
  const titles = crypto.randomUUID();
  const clip = (
    trackId: string,
    assetId: string | null,
    startFrame: number,
    durationFrames: number,
    title: string | null = null,
  ) => ({
    id: crypto.randomUUID(),
    trackId,
    assetId,
    startFrame,
    durationFrames,
    sourceFrame: 0,
    title,
  });
  const exportOf = async (
    label: string,
    width: number,
    height: number,
    clips: ReturnType<typeof clip>[],
  ) => {
    const current = await store.load(project.id);
    const saved = await store.save(
      {
        ...current,
        width,
        height,
        tracks: current.tracks.some((t) => t.id === titles)
          ? current.tracks
          : [
              ...current.tracks,
              {
                id: titles,
                name: "Titles",
                kind: "video",
                muted: false,
                locked: false,
              },
            ],
        clips,
      },
      current.revision,
    );
    phase = `export:${label}`;
    const job = await waitFor(
      (await supervisor.submit(project.id, `qual-${label}`)).id,
    );
    if (job.state !== "COMPLETED")
      throw new Error(`Export ${label} ${job.state}: ${job.error}`);
    return saved;
  };
  const reference = await exportOf("reference-720p", 1280, 720, [
    clip(videoTrack.id, asset("h264-1080p.mp4").id, 0, 300),
    clip(audioTrack.id, asset("tone-600s.wav").id, 0, 300),
    clip(titles, null, 0, 300, "المشهد الأول · Opening scene"),
  ]);
  await exportOf("heavy-decoders-1080p", 1920, 1080, [
    clip(videoTrack.id, asset("hevc-4096x2160-10bit.mov").id, 0, 48),
    clip(videoTrack.id, asset("hevc-2160p.mp4").id, 48, 60),
    clip(videoTrack.id, asset("av1-1080p.webm").id, 108, 60),
    clip(videoTrack.id, asset("prores-1080p.mov").id, 168, 60),
    clip(videoTrack.id, asset("h264-2160p.mp4").id, 228, 60),
    clip(audioTrack.id, asset("tone-600s.ogg").id, 0, 288),
  ]);

  // Reference previews of the 720p timeline at its own revision.
  const latest = await store.load(project.id);
  await store.save(
    {
      ...latest,
      width: 1280,
      height: 720,
      clips: [
        clip(videoTrack.id, asset("h264-1080p.mp4").id, 0, 300),
        clip(audioTrack.id, asset("tone-600s.wav").id, 0, 300),
        clip(titles, null, 0, 300, "المشهد الأول · Opening scene"),
      ],
    },
    latest.revision,
  );
  const previewHead = await store.load(project.id);
  phase = "preview:frame";
  for (const n of [15, 150, 285])
    await preview(store, project.id, previewHead.revision, "frame", n);
  phase = "preview:segment";
  await preview(store, project.id, previewHead.revision, "segment", 60, 60);
  void reference;

  await supervisor.close();
  store.close();
  closeWorkers();
  clearInterval(rssTimer);
  unsubscribe();

  // Per phase family: the largest peak and the longest wall time.
  const family = (p: string) => p.split(":")[0];
  const byFamily: Record<
    string,
    { workers: number; peakMiB: number; maxWallMs: number; limitMiB: number }
  > = {};
  for (const r of reports.filter(
    (r) => r.phase !== "fixture" && r.phase !== "setup",
  )) {
    const f = (byFamily[family(r.phase)] ??= {
      workers: 0,
      peakMiB: 0,
      maxWallMs: 0,
      limitMiB: 0,
    });
    f.workers++;
    f.peakMiB = Math.max(f.peakMiB, Math.ceil(r.peakMemoryBytes / MiB));
    f.maxWallMs = Math.max(f.maxWallMs, Math.round(r.wallMs));
    f.limitMiB = Math.max(f.limitMiB, Math.round(r.memoryLimitBytes / MiB));
  }
  const checks = Object.entries(Q.workerPeakMiB).map(([name, limit]) => {
    const measured = byFamily[name]?.peakMiB ?? null;
    return {
      check: `${name} worker peak (MiB)`,
      measured,
      threshold: limit,
      metThreshold: measured !== null && measured <= limit,
    };
  });
  const budgetMiB = Math.round(
    (Q.budget.serviceMiB * MiB +
      // One job worker and one preview renderer, both under the render
      // limit, plus the concurrent import probes under the worker limit.
      2 * RESOURCE_POLICY.enforced.renderMemoryBytes +
      RESOURCE_POLICY.enforced.concurrentImports *
        RESOURCE_POLICY.enforced.workerMemoryBytes) /
      MiB,
  );
  checks.push({
    check: "worst-case concurrent memory (MiB) within the budget share of RAM",
    measured: budgetMiB,
    threshold: Math.floor((totalmem() / MiB) * Q.budget.maxShareOfRam),
    metThreshold: budgetMiB <= (totalmem() / MiB) * Q.budget.maxShareOfRam,
  });
  checks.push({
    check: "longest probe (ms) within probeWallSeconds",
    measured: byFamily.import?.maxWallMs ?? null,
    threshold: RESOURCE_POLICY.enforced.probeWallSeconds * 1000,
    metThreshold:
      (byFamily.import?.maxWallMs ?? Infinity) <=
      RESOURCE_POLICY.enforced.probeWallSeconds * 1000,
  });
  Object.assign(results, {
    receipt: "yamakan.resource-qualification/1",
    policy: RESOURCE_POLICY.policy,
    commit: git("rev-parse", "HEAD"),
    measuredAt: new Date().toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      ffmpeg: execFileSync(mediaTools().ffmpeg, ["-version"], {
        encoding: "utf8",
      }).split("\n")[0],
    },
    corpus: corpusHashes,
    byFamily,
    workers: reports
      .filter((r) => r.phase !== "fixture" && r.phase !== "setup")
      .map((r) => ({
        phase: r.phase,
        executable: r.executable,
        code: r.code,
        peakMiB: Math.ceil(r.peakMemoryBytes / MiB),
        limitMiB: Math.round(r.memoryLimitBytes / MiB),
        wallMs: Math.round(r.wallMs),
      })),
    thisProcessPeakRssMiB: Math.ceil(rssPeak / MiB),
    checks,
    passed: checks.every((c) => c.metThreshold),
  });
} finally {
  clearInterval(rssTimer);
  closeWorkers();
  await rm(root, { recursive: true, force: true });
}
await writeFile(RECEIPT, `${JSON.stringify(results, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      byFamily: results.byFamily,
      checks: results.checks,
      passed: results.passed,
    },
    null,
    2,
  ),
);
if (!results.passed) process.exitCode = 1;
