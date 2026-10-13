// T10 release qualification on this machine. Records, at a clean commit:
// the environment and every pinned or built artifact by hash, cold-launch
// and reopen times against the plan's targets (launch ≤ 5 s, reopen ≤ 2 s),
// the full test suite, and the browser E2E with a capture of every TCP
// connection the service's process tree opens (the offline gate: no
// non-loopback endpoint). It never adjusts a target, and it records what
// it cannot establish here (a clean Windows profile, a second account, a
// pinned distributable bundle) rather than implying it.
import { execFileSync, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem, type, version } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";

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
  }).split("\n")[0];
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

console.log("Building the interface…");
execFileSync("npm", ["run", "-s", "build"], {
  cwd: repo,
  stdio: "ignore",
  shell: true,
});

const tools = mediaTools();
const fonts = JSON.parse(
  await readFile(path.join(repo, "docs/provenance/fonts.json"), "utf8"),
);
const environment = {
  commit: git("rev-parse", "HEAD"),
  os: `${type()} ${release()} (${version()})`,
  cpu: cpus()[0]?.model,
  logicalCores: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  ffmpeg: { version: firstLine(tools.ffmpeg), sha256: sha256(tools.ffmpeg) },
  ffprobe: { version: firstLine(tools.ffprobe), sha256: sha256(tools.ffprobe) },
  procd: sha256(path.join(nativeDir, "yamakan-procd.exe")),
  aclHelper: sha256(path.join(nativeDir, "yamakan-acl.exe")),
  fonts: (fonts as { files: { imported: string; sha256: string }[] }[]).flatMap(
    (family) =>
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

// Starts the service on a workspace and resolves when it is ready.
let nextPort = 24400;
function startService(workspace: string) {
  const port = nextPort++;
  const started = performance.now();
  const child = fork(server, [], {
    env: {
      ...process.env,
      YAMAKAN_WORKSPACE: workspace,
      YAMAKAN_PORT: String(port),
    },
    silent: true,
    windowsHide: true,
  });
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
    await done;
  };
  return { port, ready, stop };
}

const scratch = await mkdtemp(path.join(tmpdir(), "yamakan-release-qual-"));
try {
  console.log("Cold launch…");
  const launches: number[] = [];
  for (let i = 0; i < 5; i++) {
    const service = startService(path.join(scratch, `launch-${i}`));
    launches.push(await service.ready);
    await service.stop();
  }

  console.log("Reopen…");
  const workspace = path.join(scratch, "reopen");
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.create("Reopen qualification");
  const media = path.join(scratch, "media");
  const { mkdir } = await import("node:fs/promises");
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
    await service.stop();
  }

  console.log("Test suite…");
  const suite = spawn("npm", ["test"], { cwd: repo, shell: true });
  let suiteOut = "";
  suite.stdout.on("data", (c) => (suiteOut += String(c)));
  suite.stderr.on("data", (c) => (suiteOut += String(c)));
  const suiteCode = await new Promise<number>((r) => suite.once("exit", r));
  const count = (key: string) =>
    Number(new RegExp(`ℹ ${key} (\\d+)`).exec(suiteOut)?.[1] ?? NaN);

  console.log("Browser E2E with connection capture…");
  const pidFile = path.join(scratch, "service.pid");
  const e2e = spawn(
    process.execPath,
    [path.join(repo, "scripts/browser-e2e.mjs")],
    {
      cwd: repo,
      env: { ...process.env, YAMAKAN_E2E_PID_FILE: pidFile },
    },
  );
  let e2eOut = "";
  e2e.stdout.on("data", (c) => (e2eOut += String(c)));
  e2e.stderr.on("data", (c) => (e2eOut += String(c)));
  let finished = false;
  const e2eCode = new Promise<number>((r) =>
    e2e.once("exit", (code) => {
      finished = true;
      r(code ?? 1);
    }),
  );
  // Every TCP connection owned by the service and its descendants (procd,
  // FFmpeg/ffprobe workers), sampled until the E2E ends.
  const probe = (pid: number) =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $tree = @(${pid}); $grew = $true; while ($grew) { $grew = $false; foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $grew = $true } } }; Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } | ForEach-Object { "$($_.RemoteAddress) $($_.RemotePort) $($_.State)" }`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  const endpoints = new Set<string>();
  let samples = 0;
  while (!finished) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      for (const line of probe(pid).split(/\r?\n/).filter(Boolean))
        endpoints.add(line.split(" ").slice(0, 2).join(":"));
      samples++;
    } catch {
      // The tree is gone between listing and querying; the next sample counts.
    }
  }
  const e2eExit = await e2eCode;
  const local = /^(127\.|::1|0\.0\.0\.0|::)/;
  const external = [...endpoints].filter(
    (e) => !local.test(e.split(":")[0] ?? ""),
  );
  const pageErrors = /pageErrors: \[\]/.test(e2eOut) ? 0 : null;

  const receipt = {
    receipt: "yamakan.release-qualification/1",
    measuredAt: new Date().toISOString(),
    environment,
    targets: { coldLaunchMs: 5000, reopenMs: 2000 },
    coldLaunch: { ...stats(launches), metTarget: stats(launches).p95 <= 5000 },
    reopen: {
      fixture:
        "one 10 s 1280x720 H.264/AAC clip, 200 saved revisions; service start to project open over the authenticated API",
      ...stats(reopens),
      metTarget: stats(reopens).p95 <= 2000,
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
      method:
        "Get-NetTCPConnection for the service process and every descendant, sampled every 0.5 s during the browser E2E (the browser itself is not the product and is not counted)",
      samples,
      endpoints: [...endpoints].sort(),
      external,
      passed: samples > 0 && external.length === 0,
    },
    notEstablishedHere: [
      "Clean Windows Profile A (fresh user profile, nothing pre-installed): this run used the development profile",
      "Second local Windows account denied: established by a restricted-token proxy in tests, not by a real second account",
      "Pinned distributable bundle (runtime, FFmpeg, fonts, notices) with install, update, rollback and uninstall",
      "Real constrained-volume disk-full runs on Windows and Linux",
      "Native Arabic review of title goldens and interface strings",
      "10-minute audio-drift fixture and the full preview/export SSIM comparison harness",
      "MCP/REST parity replay of journey steps 2-11 with canonical byte comparison",
    ],
  };
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  if (suiteCode !== 0 || e2eExit !== 0) process.exitCode = 1;
} finally {
  closeWorkers();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
