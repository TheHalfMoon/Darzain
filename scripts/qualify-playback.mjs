// 720p playback qualification (frozen policy threshold playback720p:
// "interactive editor playback of a 720p timeline", ≥ 24 fps). Builds an
// 18 s 1280x720 timeline (three moving-picture clips with two cuts, an
// overlapping upper-track clip, a title, a sound clip), opens it in the real
// editor in Microsoft Edge, presses Play and counts the frames the preview
// canvas actually shows: on every animation frame the page samples a 16x16
// block of the canvas and counts content changes (the sources change on
// every frame). Scenarios: sustained play from the start for 15 s (gated by
// the threshold); a seek to 5.5 s then 3 s of play across the cut at 6 s; and
// 10 s of play while an export renders (resource pressure). The seek and
// pressure scenarios are measured and reported, not gated. The receipt also
// records the WebGL renderer the browser reports, since headless Edge may
// composite in software. It runs only on a clean tree.
import { chromium } from "playwright-core";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { QUALIFICATION_POLICY } from "../core/qualification-policy.ts";
import { mediaTools } from "../core/process/workers.ts";

const RECEIPT = "docs/evidence/qualification/playback.json";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ".", `:!${RECEIPT}`);
if (dirty)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);
const MIN_FPS = QUALIFICATION_POLICY.thresholds.playback720p.minFps;

const root = mkdtempSync(join(tmpdir(), "yamakan-playback-"));
const { ffmpeg } = mediaTools();
const make = (name, args) => {
  const file = join(root, name);
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args, file],
    {
      windowsHide: true,
    },
  );
  return file;
};
const moving = (seconds, size = "1280x720") => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${size}:rate=30:duration=${seconds}`,
  "-pix_fmt",
  "yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-g",
  "60",
];
const media = {
  "a.mp4": make("a.mp4", moving(6)),
  "b.mp4": make("b.mp4", moving(6)),
  "c.mp4": make("c.mp4", moving(6)),
  "overlay.mp4": make("overlay.mp4", moving(4)),
  "tone.wav": make("tone.wav", [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=18",
  ]),
};

const port = 24345;
const url = `http://127.0.0.1:${port}`;
const server = fork(
  fileURLToPath(new URL("../server/main.ts", import.meta.url)),
  [],
  {
    env: {
      ...process.env,
      YAMAKAN_WORKSPACE: join(root, "workspace"),
      YAMAKAN_PORT: String(port),
    },
    silent: true,
    windowsHide: true,
  },
);
let serverError = "";
server.stderr.on("data", (c) => (serverError += c));
let browser;
let receipt;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`startup: ${serverError}`)),
      15000,
    );
    server.stdout.on(
      "data",
      (c) =>
        String(c).includes("Yamakan is running") &&
        (clearTimeout(timer), resolve()),
    );
    server.once("exit", (code) =>
      reject(new Error(`server exited ${code}: ${serverError}`)),
    );
  });
  const token = readFileSync(join(root, "workspace", "token"), "utf8").trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const call = async (operation, parameters) => {
    const r = await fetch(`${url}/api/v1/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiVersion: 1, operation, parameters }),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(`${operation}: ${JSON.stringify(v.error)}`);
    return v.result;
  };
  const project = await call("yamakan.project.create", {
    name: "Playback 720p",
  });
  const assets = {};
  for (const [name, file] of Object.entries(media)) {
    const r = await fetch(`${url}/api/v1/projects/${project.id}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Asset-Name": name },
      body: readFileSync(file),
    });
    if (!r.ok) throw new Error(`import ${name}: ${await r.text()}`);
    assets[name] = (await r.json()).asset.id;
  }
  const head = await call("yamakan.project.open", { projectId: project.id });
  const id = () => crypto.randomUUID();
  const [picture, sound] = head.tracks;
  const upper = {
    id: id(),
    name: "Upper",
    kind: "video",
    muted: false,
    locked: false,
  };
  const titles = {
    id: id(),
    name: "Titles",
    kind: "video",
    muted: false,
    locked: false,
  };
  const clip = (trackId, asset, startFrame, durationFrames, title = null) => ({
    id: id(),
    trackId,
    assetId: asset ? assets[asset] : null,
    startFrame,
    durationFrames,
    sourceFrame: 0,
    title,
  });
  await call("yamakan.project.save", {
    expectedRevision: head.revision,
    project: {
      ...head,
      width: 1280,
      height: 720,
      tracks: [picture, upper, titles, sound],
      clips: [
        clip(picture.id, "a.mp4", 0, 180),
        clip(picture.id, "b.mp4", 180, 180),
        clip(picture.id, "c.mp4", 360, 180),
        clip(upper.id, "overlay.mp4", 270, 120),
        clip(titles.id, null, 60, 240, "المشهد الأول · Opening scene"),
        clip(sound.id, "tone.wav", 0, 540),
      ],
    },
  });

  browser = await chromium.launch({
    channel: process.env.YAMAKAN_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const page = await (
    await browser.newContext({ viewport: { width: 1600, height: 1100 } })
  ).newPage();
  const launch = readFileSync(join(root, "workspace", "launch"), "utf8").trim();
  await page.goto(launch);
  await page.waitForFunction(() => location.hash === "");
  await page.getByRole("button", { name: "Playback 720p" }).click();
  await page
    .getByRole("heading", { name: "Playback 720p", exact: true })
    .waitFor();
  const canvas = page.locator("section.preview canvas");
  await canvas.waitFor();
  const size = await canvas.evaluate((c) => [c.width, c.height]);
  if (size[0] !== 1280 || size[1] !== 720)
    throw new Error(`preview canvas is ${size}`);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl
        ? gl.getParameter(gl.RENDERER)
        : "none";
  });

  // Counts canvas content changes on every animation frame until stopped.
  const startSampler = () =>
    page.evaluate(() => {
      const c = document.querySelector("section.preview canvas");
      const ctx = c.getContext("2d");
      const state = { changes: [], frames: 0, running: true, last: -1 };
      window.__sampler = state;
      const tick = (now) => {
        if (!state.running) return;
        state.frames++;
        const d = ctx.getImageData(
          c.width / 2 - 8,
          c.height / 3 - 8,
          16,
          16,
        ).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4)
          h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
        if (h !== state.last) state.changes.push(now);
        state.last = h;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const stopSampler = () =>
    page.evaluate(() => {
      window.__sampler.running = false;
      return {
        changes: window.__sampler.changes,
        frames: window.__sampler.frames,
      };
    });
  const playFor = async (from, seconds) => {
    await page.getByLabel("Playhead").fill(String(from));
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    // Let playback settle before counting.
    await page.waitForTimeout(500);
    await startSampler();
    await page.waitForTimeout(seconds * 1000);
    const sample = await stopSampler();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForTimeout(300);
    const t = sample.changes;
    const elapsed = (t.at(-1) - t[0]) / 1000;
    const fps = (t.length - 1) / elapsed;
    // Frames shown in each whole second of the window.
    const windows = [];
    for (let s = t[0]; s + 1000 <= t.at(-1); s += 1000)
      windows.push(t.filter((x) => x >= s && x < s + 1000).length);
    return {
      fromSeconds: from,
      seconds,
      animationFrames: sample.frames,
      framesShown: t.length,
      fps: Math.round(fps * 10) / 10,
      minOneSecondWindow: Math.min(...windows),
      // A 30 fps timeline shows 30 new frames a second when nothing drops.
      droppedEstimate: Math.max(0, Math.round(elapsed * 30 - (t.length - 1))),
    };
  };
  const sustained = await playFor(0, 15);
  const seek = await playFor(5.5, 3);
  // Resource pressure: an export renders while the editor plays.
  const job = await call("yamakan.export.video", {
    projectId: project.id,
    idempotencyKey: "pressure",
  });
  const pressure = await playFor(0, 10);
  const exported = await call("yamakan.job.status", { jobId: job.id });

  const checks = [
    {
      check: `sustained 720p playback (15 s, two cuts, overlay, title) at ≥ ${MIN_FPS} fps`,
      measured: sustained.fps,
      threshold: MIN_FPS,
      metThreshold: sustained.fps >= MIN_FPS,
      gated: true,
    },
    {
      check: "seek to 5.5 s, then play across the cut at 6 s",
      measured: seek.fps,
      threshold: MIN_FPS,
      metThreshold: seek.fps >= MIN_FPS,
      gated: false,
    },
    {
      check: "play while an export renders (resource pressure)",
      measured: pressure.fps,
      threshold: MIN_FPS,
      metThreshold: pressure.fps >= MIN_FPS,
      gated: false,
    },
  ];
  receipt = {
    receipt: "yamakan.playback-qualification/1",
    policy: QUALIFICATION_POLICY.policy,
    commit: git("rev-parse", "HEAD"),
    measuredAt: new Date().toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      browser: `${browser.browserType().name()} ${browser.version()} (headless)`,
      webglRenderer: renderer,
      ffmpegSha256: createHash("sha256")
        .update(readFileSync(ffmpeg))
        .digest("hex"),
    },
    fixture:
      "18 s 1280x720 timeline: three 6 s testsrc2 H.264 clips (cuts at 6 s and 12 s), a 4 s upper-track clip from 9 s, an Arabic/Latin title from 2 s to 10 s, a tone; frames shown counted from canvas content changes",
    sustained,
    seek,
    pressure: { ...pressure, exportState: exported.state },
    checks,
    passed: checks.filter((c) => c.gated).every((c) => c.metThreshold),
  };
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) {
    const done = once(server, "exit");
    server.send("shutdown");
    await done;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      sustained: receipt.sustained,
      seek: receipt.seek,
      pressure: receipt.pressure,
      passed: receipt.passed,
    },
    null,
    2,
  ),
);
if (!receipt.passed) process.exitCode = 1;
