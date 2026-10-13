// T10 release qualification on this machine. Records, at a clean commit:
// the environment and every pinned or built artifact by hash (native helpers
// are rebuilt first, so their hashes are the commit's), cold-launch and
// reopen times against the frozen qualification policy
// (core/qualification-policy.ts), the full test suite, and the browser E2E with two offline checks:
// every request the browser pages make (recorded by the E2E) and a sampled
// capture of the TCP connections and listeners of the service's process
// tree. It never adjusts a target, and it records what it cannot establish
// here (a clean Windows profile, a second account, a pinned distributable
// bundle) rather than implying it.
import { execFileSync, fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem, type, version } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import { QUALIFICATION_POLICY } from "../core/qualification-policy.ts";

const LIMITS = QUALIFICATION_POLICY.thresholds;

const RECEIPT = "docs/evidence/qualification/t10-release.json";
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ".", `:!${RECEIPT}`);
if (dirty)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);

const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const firstLine = (exe: string) =>
  execFileSync(exe, ["-hide_banner", "-version"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .split("\n")[0]
    .trim();
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
// Every file below a folder, by path and hash, folded into one digest.
function treeDigest(dir: string) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(`${path.relative(dir, file)}\0${sha256(file)}\n`);
  return { files: files.length, sha256: hash.digest("hex") };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const server = path.join(repo, "server", "main.ts");
const nativeDir = path.join(repo, "native", "procd", "target", "release");
const npm = (...args: string[]) =>
  execFileSync("npm", ["run", "-s", ...args], {
    cwd: repo,
    stdio: "ignore",
    shell: true,
  });

console.log("Building the native helpers and the interface…");
npm("build:native");
npm("build");

// The browser the E2E drives (its default channel, Microsoft Edge).
function edge() {
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ].map((base) =>
    base
      ? path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
  );
  const exe = candidates.find((c) => c && existsSync(c));
  if (!exe) return null;
  const versionText = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Item -LiteralPath $env:YQ_EDGE).VersionInfo.ProductVersion",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, YQ_EDGE: exe },
    },
  ).trim();
  return { version: versionText, sha256: sha256(exe) };
}

const tools = mediaTools();
const fonts = JSON.parse(
  await readFile(path.join(repo, "docs/provenance/fonts.json"), "utf8"),
) as { files: { imported: string; sha256: string }[] }[];
const environment = {
  commit: git("rev-parse", "HEAD"),
  os: `${type()} ${release()} (${version()})`,
  cpu: cpus()[0]?.model,
  logicalCores: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: { version: process.version, sha256: sha256(process.execPath) },
  browser: edge(),
  ffmpeg: { version: firstLine(tools.ffmpeg), sha256: sha256(tools.ffmpeg) },
  ffprobe: { version: firstLine(tools.ffprobe), sha256: sha256(tools.ffprobe) },
  procd: sha256(path.join(nativeDir, "yamakan-procd.exe")),
  aclHelper: sha256(path.join(nativeDir, "yamakan-acl.exe")),
  fonts: fonts.flatMap((family) =>
    family.files.map((f) => ({
      file: f.imported,
      sha256: f.sha256,
      verified: existsSync(path.join(repo, f.imported))
        ? sha256(path.join(repo, f.imported)) === f.sha256
        : false,
    })),
  ),
  interface: treeDigest(path.join(repo, "dist")),
};

// Every child this run starts, so a failure stops them all.
const children = new Set<ChildProcess>();
const track = (child: ChildProcess) => {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
};

// Starts the service on a workspace and resolves when it is ready.
let nextPort = 24400;
function startService(workspace: string) {
  const port = nextPort++;
  const started = performance.now();
  const child = track(
    fork(server, [], {
      env: {
        ...process.env,
        YAMAKAN_WORKSPACE: workspace,
        YAMAKAN_PORT: String(port),
      },
      silent: true,
      windowsHide: true,
    }),
  );
  let errors = "";
  child.stderr?.on("data", (c) => (errors += String(c)));
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Start-up timeout: ${errors}`)),
      30000,
    );
    child.stdout?.on("data", (c) => {
      if (String(c).includes("Yamakan is running")) {
        clearTimeout(timer);
        resolve(performance.now() - started);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Service exited ${code}: ${errors}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const done = new Promise((r) => child.once("exit", r));
    child.send("shutdown");
    const timer = setTimeout(() => child.kill(), 15000);
    await done;
    clearTimeout(timer);
  };
  return { port, ready, stop };
}

const scratch = await mkdtemp(path.join(tmpdir(), "yamakan-release-qual-"));
try {
  console.log("Cold launch…");
  const launches: number[] = [];
  for (let i = 0; i < 5; i++) {
    const service = startService(path.join(scratch, `launch-${i}`));
    try {
      launches.push(await service.ready);
    } finally {
      await service.stop();
    }
  }

  console.log("Reopen…");
  const workspace = path.join(scratch, "reopen");
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.create("Reopen qualification");
  const media = path.join(scratch, "media");
  await mkdir(media);
  execFileSync(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30:duration=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=10",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      path.join(media, "clip.mp4"),
    ],
    { windowsHide: true },
  );
  await store.importAsset(
    project.id,
    "clip.mp4",
    await readFile(path.join(media, "clip.mp4")),
  );
  // A history of edits behind the head, as a worked project has.
  for (let i = 0; i < 200; i++) {
    const head = await store.load(project.id);
    await store.save(
      { ...head, name: `Reopen qualification ${i}` },
      head.revision,
    );
  }
  store.close();
  closeWorkers();
  const reopens: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const service = startService(workspace);
    try {
      await service.ready;
      const token = (
        await readFile(path.join(workspace, "token"), "utf8")
      ).trim();
      const response = await fetch(
        `http://127.0.0.1:${service.port}/api/v1/call`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiVersion: 1,
            operation: "yamakan.project.open",
            parameters: { projectId: project.id },
          }),
        },
      );
      if (!response.ok) throw new Error(`Open failed: ${response.status}`);
      reopens.push(performance.now() - started);
    } finally {
      await service.stop();
    }
  }

  console.log("Test suite…");
  const suite = track(spawn("npm", ["test"], { cwd: repo, shell: true }));
  let suiteOut = "";
  suite.stdout?.on("data", (c) => (suiteOut += String(c)));
  suite.stderr?.on("data", (c) => (suiteOut += String(c)));
  const suiteCode = await new Promise<number>((r) =>
    suite.once("exit", (code) => r(code ?? 1)),
  );
  const count = (key: string) =>
    Number(new RegExp(`ℹ ${key} (\\d+)`).exec(suiteOut)?.[1] ?? NaN);

  console.log("Browser E2E with connection capture…");
  const pidFile = path.join(scratch, "service.pid");
  const stopFile = path.join(scratch, "sampler.stop");
  const e2e = track(
    spawn(process.execPath, [path.join(repo, "scripts/browser-e2e.mjs")], {
      cwd: repo,
      env: { ...process.env, YAMAKAN_E2E_PID_FILE: pidFile },
    }),
  );
  let e2eOut = "";
  e2e.stdout?.on("data", (c) => (e2eOut += String(c)));
  e2e.stderr?.on("data", (c) => (e2eOut += String(c)));
  let finished = false;
  const e2eCode = new Promise<number>((r) =>
    e2e.once("exit", (code) => {
      finished = true;
      r(code ?? 1);
    }),
  );
  // The service process and every descendant (procd, FFmpeg/ffprobe
  // workers): their TCP connections and listeners, sampled by one
  // long-running sampler. Each sample rebuilds the process tree (about a
  // second on this machine), so a connection shorter than the gap can be
  // missed; the receipt states the sample count and mean gap. Paths reach
  // the sampler through its environment, never inside the command text.
  // It also stops if this run ends, or after 30 minutes.
  const sampler = track(
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$deadline = (Get-Date).AddMinutes(30)",
          "while (-not (Test-Path -LiteralPath $env:YQ_STOP) -and (Get-Process -Id ([int]$env:YQ_PARENT) -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {",
          "  if (Test-Path -LiteralPath $env:YQ_PID) {",
          "    $root = [int](Get-Content -LiteralPath $env:YQ_PID)",
          "    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId",
          "    $tree = @($root); $grew = $true",
          "    while ($grew) { $grew = $false; foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $grew = $true } } }",
          "    Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } | ForEach-Object { 'E ' + $_.LocalAddress + ' ' + $_.RemoteAddress + ' ' + $_.RemotePort + ' ' + $_.State }",
          "    'S'",
          "  }",
          "  Start-Sleep -Milliseconds 200",
          "}",
        ].join("\n"),
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          YQ_PID: pidFile,
          YQ_STOP: stopFile,
          YQ_PARENT: String(process.pid),
        },
      },
    ),
  );
  type Seen = { local: string; remote: string; port: number; state: string };
  const seen = new Map<string, Seen>();
  let samples = 0;
  let firstSample = 0;
  let lastSample = 0;
  let buffer = "";
  sampler.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "S") {
        samples++;
        lastSample = performance.now();
        firstSample ||= lastSample;
      } else if (line.startsWith("E ")) {
        const [local, remote, port, state] = line.slice(2).split(" ");
        seen.set(line, { local, remote, port: Number(port), state });
      }
    }
  });
  const samplerDone = new Promise((r) => sampler.once("exit", r));
  while (!finished) await new Promise((r) => setTimeout(r, 200));
  await writeFile(stopFile, "");
  await samplerDone;
  const e2eExit = await e2eCode;
  const sampleGapMs =
    samples > 1 ? Math.round((lastSample - firstSample) / (samples - 1)) : null;
  const loopback = (a: string) => a === "::1" || a.startsWith("127.");
  const unspecified = (a: string) => a === "0.0.0.0" || a === "::";
  const connections = [...seen.values()];
  // A connection to anything but this machine, and a listener reachable
  // from anything but this machine.
  const external = connections.filter(
    (c) => !loopback(c.remote) && !unspecified(c.remote),
  );
  const exposedListeners = connections.filter(
    (c) => c.state === "Listen" && !loopback(c.local),
  );
  const pageErrors = /pageErrors: \[\]/.test(e2eOut) ? 0 : null;
  const pageRequests = Number(/pageRequests: (\d+)/.exec(e2eOut)?.[1] ?? NaN);
  const externalPageRequests = Number(
    /externalPageRequests: (\d+)/.exec(e2eOut)?.[1] ?? NaN,
  );

  const receipt = {
    receipt: "yamakan.release-qualification/2",
    measuredAt: new Date().toISOString(),
    environment,
    policy: {
      version: QUALIFICATION_POLICY.policy,
      approved: QUALIFICATION_POLICY.approved,
      hardware: QUALIFICATION_POLICY.hardware,
      coldLaunchP95Ms: LIMITS.coldLaunch.p95Ms,
      reopenP95Ms: LIMITS.reopen.p95Ms,
    },
    coldLaunch: {
      method:
        "service start to its ready line on a fresh workspace, 5 runs; the OS file cache is warm after the build (fresh workspace, not a cold OS cache); with 5 runs p95 is the maximum",
      ...stats(launches),
      passed: stats(launches).p95 <= LIMITS.coldLaunch.p95Ms,
    },
    reopen: {
      fixture:
        "one 10 s 1280x720 H.264/AAC clip, 200 saved revisions; service start to project open over the authenticated API, 5 runs",
      ...stats(reopens),
      passed: stats(reopens).p95 <= LIMITS.reopen.p95Ms,
    },
    tests: {
      exitCode: suiteCode,
      total: count("tests"),
      pass: count("pass"),
      fail: count("fail"),
      skipped: count("skipped"),
    },
    e2e: { exitCode: e2eExit, pageErrors },
    offline: {
      browserPages: {
        method:
          "every request made by the journey's browser pages, recorded by the E2E (page.on('request')); allowed: 127.0.0.1, blob:, data:, and the browser's own built-in pages (about:, edge:, chrome:, such as its download panel), which are not network requests",
        requests: pageRequests,
        external: externalPageRequests,
      },
      serviceTree: {
        method:
          "Get-NetTCPConnection for the service process and every descendant, sampled during the browser E2E; UDP (DNS) is not captured, and a connection shorter than the sample gap can be missed",
        samples,
        meanSampleGapMs: sampleGapMs,
        connections: connections.length,
        external,
        exposedListeners,
      },
      passed:
        samples > 0 &&
        external.length === 0 &&
        exposedListeners.length === 0 &&
        externalPageRequests === 0,
      networkEnabled: true,
    },
    notEstablishedHere: [
      "Clean Windows Profile A (fresh user profile, nothing pre-installed): this run used the development profile",
      "Network disabled with a packet-level egress capture: this run had the network enabled and sampled TCP only",
      "Second local Windows account denied: established by a restricted-token proxy in tests, not by a real second account",
      "Pinned distributable bundle (runtime, FFmpeg, fonts, notices, SBOM) with install, update, rollback and uninstall",
      "Release evidence bundle at the release head: MP4 and canonical hashes, ffprobe JSON, sampled frames and title regions, audio report, UI+MCP transcript, process lifecycle reports",
      "Real constrained-volume disk-full runs on Windows and Linux",
      "Native Arabic review of title goldens and interface strings",
      "10-minute audio-drift fixture and the full preview/export comparison harness",
      "MCP/REST parity replay of journey steps 2-11 with canonical byte comparison",
    ],
  };
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  if (suiteCode !== 0 || e2eExit !== 0 || !receipt.offline.passed)
    process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  closeWorkers();
  await rm(scratch, { recursive: true, force: true }).catch((e) =>
    console.error(`Scratch folder not removed: ${(e as Error).message}`),
  );
}
