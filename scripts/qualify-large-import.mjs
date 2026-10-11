// T4 qualification: a >= 2 GiB media import streams through the real service
// within the memory ceiling. Generates a raw-video MOV, uploads it over HTTP
// with Content-Length, samples the service's working set throughout, verifies
// the published object, and writes a receipt without host paths.
//   node scripts/qualify-large-import.mjs [work folder on a volume with ~8 GB free]
import { execFileSync, fork, spawn } from "node:child_process";
import { createReadStream, mkdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const MiB = 1024 * 1024;
const MIN_BYTES = 2 * 1024 * MiB;
const CEILING = 300 * MiB;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.resolve(process.argv[2] || path.join(repo, "work", "qualification"));
const run = path.join(work, `large-import-${Date.now()}`);
mkdirSync(run, { recursive: true });
const free = statfsSync(run);
if (Number(free.bavail) * Number(free.bsize) < 8 * 1024 * MiB)
  throw new Error("Need about 8 GB free for the source, staging and the published object.");

const ffmpeg = process.env.YAMAKAN_FFMPEG || "ffmpeg";
const source = path.join(run, "large.mov");
const port = 24397;
let server;
let sampler;
try {
  // 18 s of 1080p raw 4:2:2 video (QuickTime 2vuy): 540 frames x 4,147,200 bytes.
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=size=1920x1080:rate=30", "-t", "18", "-c:v", "rawvideo",
      "-pix_fmt", "uyvy422", source],
    { windowsHide: true },
  );
  const bytes = statSync(source).size;
  assert.ok(bytes >= MIN_BYTES, `fixture is ${bytes} bytes`);

  const workspace = path.join(run, "workspace");
  server = fork(path.join(repo, "server", "main.ts"), [], {
    env: { ...process.env, YAMAKAN_WORKSPACE: workspace, YAMAKAN_PORT: String(port) },
    silent: true,
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (c) => String(c).includes("Yamakan is running") && resolve());
    server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const token = (await readFile(path.join(workspace, "token"), "utf8")).trim();
  const call = async (operation, parameters) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, operation, parameters }),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(v.error));
    return v.result;
  };
  const project = await call("yamakan.project.create", { name: "Large import" });

  // Sample the service's resident set every 200 ms for the whole upload.
  const samples = [];
  if (process.platform === "win32") {
    sampler = spawn(
      "powershell",
      ["-NoProfile", "-Command",
        `while ($true) { try { (Get-Process -Id ${server.pid}).WorkingSet64 } catch { break }; Start-Sleep -Milliseconds 200 }`],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    sampler.stdout.on("data", (c) =>
      String(c).split(/\s+/).filter(Boolean).forEach((n) => samples.push(Number(n))),
    );
  } else {
    const timer = setInterval(() => {
      try {
        const kb = /VmRSS:\s+(\d+)/.exec(
          execFileSync("cat", [`/proc/${server.pid}/status`], { encoding: "utf8" }),
        )?.[1];
        if (kb) samples.push(Number(kb) * 1024);
      } catch {}
    }, 200);
    sampler = { kill: () => clearInterval(timer) };
  }

  const started = performance.now();
  const response = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/v1/projects/${project.id}/assets`,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Asset-Name": "large.mov",
          "Content-Length": bytes,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    createReadStream(source, { highWaterMark: MiB }).pipe(req);
  });
  const seconds = (performance.now() - started) / 1000;
  sampler.kill();
  assert.equal(response.status, 200, response.body);
  const imported = JSON.parse(response.body);
  assert.equal(imported.asset.bytes, bytes);

  // The published object is byte-identical to the source.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  assert.equal(imported.asset.hash, hash.digest("hex"));

  const peak = Math.max(...samples);
  const receipt = {
    qualification: "T4 large import",
    date: new Date().toISOString(),
    host: { platform: process.platform, release: os.release(), cpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3) },
    node: process.version,
    fixture: "FFmpeg testsrc2 1920x1080, 18 s rawvideo uyvy422 MOV (synthetic test pattern)",
    bytes,
    seconds: Math.round(seconds * 10) / 10,
    samples: samples.length,
    peakServiceWorkingSetMiB: Math.round(peak / MiB),
    ceilingMiB: CEILING / MiB,
    pass: peak <= CEILING && samples.length > 0,
  };
  console.log(JSON.stringify(receipt, null, 2));
  mkdirSync(path.join(repo, "work", "qualification"), { recursive: true });
  writeFileSync(path.join(repo, "work", "qualification", "large-import.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.pass) process.exitCode = 1;
} finally {
  sampler?.kill();
  if (server && server.exitCode === null) {
    server.send?.("shutdown");
    await once(server, "exit").catch(() => {});
  }
  rmSync(run, { recursive: true, force: true });
}
