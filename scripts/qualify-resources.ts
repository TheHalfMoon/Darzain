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
// The process owner measured is the one built from this tree (procd is a
// git-ignored build output a clean tree cannot vouch for).
execFileSync(
  "cargo",
  ["build", "--release", "--manifest-path", "native/procd/Cargo.toml"],
  { stdio: "ignore", windowsHide: true },
);
const procdSha256 = createHash("sha256")
  .update(await readFile("native/procd/target/release/yamakan-procd.exe"))
  .digest("hex");
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
      // The largest accepted video: 4096 pixels on both sides.
      name: "h264-4096x4096.mp4",
      args: [
        ...v("4096x4096", 30, 2),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
      ],
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
  // Three runs (separate revisions, so each renders): the spread between
  // them is recorded with the receipt.
  for (const run of [1, 2, 3])
    await exportOf(`heavy-decoders-1080p-${run}`, 1920, 1080, [
      clip(videoTrack.id, asset("hevc-4096x2160-10bit.mov").id, 0, 48),
      clip(videoTrack.id, asset("hevc-2160p.mp4").id, 48, 60),
      clip(videoTrack.id, asset("h264-4096x4096.mp4").id, 108, 60),
      clip(videoTrack.id, asset("av1-1080p.webm").id, 168, 60),
      clip(videoTrack.id, asset("prores-1080p.mov").id, 228, 60),
      clip(videoTrack.id, asset("h264-2160p.mp4").id, 288, 60 + run),
      clip(audioTrack.id, asset("tone-600s.ogg").id, 0, 348 + run),
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

  // Every worker the corpus started, judged against the limit it ran under.
  const share = Q.workerPeakShareOfLimit;
  const limits = new Set([
    RESOURCE_POLICY.enforced.workerMemoryBytes,
    RESOURCE_POLICY.enforced.renderMemoryBytes,
  ]);
  const measured = reports.filter(
    (r) => r.phase !== "fixture" && r.phase !== "setup",
  );
  const perWorker = measured.map((r) => ({
    phase: r.phase,
    executable: r.executable,
    code: r.code,
    peakMiB:
      r.peakMemoryBytes === null ? null : Math.ceil(r.peakMemoryBytes / MiB),
    limitMiB: Math.round(r.memoryLimitBytes / MiB),
    shareOfLimit:
      r.peakMemoryBytes === null || !r.memoryLimitBytes
        ? null
        : Math.round((r.peakMemoryBytes / r.memoryLimitBytes) * 1000) / 1000,
    wallMs: Math.round(r.wallMs),
    metThreshold:
      r.peakMemoryBytes !== null &&
      r.peakMemoryBytes > 0 &&
      limits.has(r.memoryLimitBytes) &&
      r.peakMemoryBytes <= share * r.memoryLimitBytes,
  }));
  // Per phase family, for reading: workers, the largest peak and its share
  // of the limit, and the longest wall time.
  const family = (p: string) => p.split(":")[0];
  const byFamily: Record<
    string,
    {
      workers: number;
      peakMiB: number;
      maxShareOfLimit: number;
      maxWallMs: number;
    }
  > = {};
  for (const w of perWorker) {
    const f = (byFamily[family(w.phase)] ??= {
      workers: 0,
      peakMiB: 0,
      maxShareOfLimit: 0,
      maxWallMs: 0,
    });
    f.workers++;
    f.peakMiB = Math.max(f.peakMiB, w.peakMiB ?? 0);
    f.maxShareOfLimit = Math.max(f.maxShareOfLimit, w.shareOfLimit ?? 0);
    f.maxWallMs = Math.max(f.maxWallMs, w.wallMs);
  }
  const heavy = perWorker
    .filter(
      (w) =>
        w.phase.startsWith("export:heavy-") &&
        w.limitMiB === RESOURCE_POLICY.enforced.renderMemoryBytes / MiB,
    )
    .map((w) => w.peakMiB ?? 0);
  const checks: {
    check: string;
    measured: number | null;
    threshold: number;
    metThreshold: boolean;
  }[] = [
    {
      check: `workers with a measured peak within ${share * 100}% of an enforced Job Object limit`,
      measured: perWorker.filter((w) => w.metThreshold).length,
      threshold: perWorker.length,
      metThreshold:
        perWorker.length > 0 && perWorker.every((w) => w.metThreshold),
    },
    ...["import", "conversion", "export", "preview"].map((name) => ({
      check: `${name} workers measured`,
      measured: byFamily[name]?.workers ?? 0,
      threshold: 1,
      metThreshold: (byFamily[name]?.workers ?? 0) >= 1,
    })),
  ];
  const budgetMiB = Math.round(
    (Q.budget.serviceMiB * MiB +
      // One job worker and one preview renderer under the render limit;
      // the concurrent import probes and one engine check under the worker
      // limit.
      2 * RESOURCE_POLICY.enforced.renderMemoryBytes +
      (RESOURCE_POLICY.enforced.concurrentImports + 1) *
        RESOURCE_POLICY.enforced.workerMemoryBytes) /
      MiB,
  );
  checks.push({
    check: "worst-case concurrent memory (MiB) within the budget share of RAM",
    measured: budgetMiB,
    threshold: Math.floor((totalmem() / MiB) * Q.budget.maxShareOfRam),
    metThreshold: budgetMiB <= (totalmem() / MiB) * Q.budget.maxShareOfRam,
  });
  const longestProbe = Math.max(
    0,
    ...perWorker
      .filter((w) => /^ffprobe/i.test(w.executable))
      .map((w) => w.wallMs),
  );
  checks.push({
    check: "longest probe (ms) within probeWallSeconds",
    measured: longestProbe || null,
    threshold: RESOURCE_POLICY.enforced.probeWallSeconds * 1000,
    metThreshold:
      longestProbe > 0 &&
      longestProbe <= RESOURCE_POLICY.enforced.probeWallSeconds * 1000,
  });
  Object.assign(results, {
    receipt: "yamakan.resource-qualification/2",
    policy: RESOURCE_POLICY.policy,
    commit: git("rev-parse", "HEAD"),
    cleanTree: !dirty,
    measuredAt: new Date().toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      ffmpeg: execFileSync(mediaTools().ffmpeg, ["-version"], {
        encoding: "utf8",
      })
        .split("\n")[0]
        .trim(),
      ffmpegSha256: sha256(await readFile(mediaTools().ffmpeg)),
      ffprobeSha256: sha256(await readFile(mediaTools().ffprobe)),
      procdSha256,
    },
    corpus: corpusHashes,
    byFamily,
    heavyExportRunsPeakMiB: heavy,
    workers: perWorker,
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
