// Worker read containment (release-blocking; docs/RELEASE_PROPOSAL.md).
// A worker runs in an AppContainer with its own capability: it may read its
// executable, system files and the paths its request names, write only its
// writable folder, and open no network connection. A stand-in hostile worker
// (Node running a script, as a compromised FFmpeg would run code) tries to
// read a sentinel outside the workspace, the service's token and launch
// link, the workspace database and media it was not given; to write outside
// its folder; to connect to loopback and to this machine's network address;
// and to start another process. Controls show the same reads, writes and
// connections succeed for an uncontained process, and that the granted
// input and folder do work for the worker. Afterwards its grants are gone.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessOwner } from "../core/process/owner.ts";
import { mediaTools } from "../core/process/workers.ts";

const windows = process.platform === "win32";
const folders: string[] = [];
after(async () => {
  await Promise.all(
    folders.map((f) => rm(f, { recursive: true, force: true })),
  );
});

// What the hostile worker attempts; prints one JSON line of outcomes.
const HOSTILE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const cp = require("node:child_process");
const [targets] = process.argv.slice(1);
const t = JSON.parse(targets);
const out = {};
const tryRead = (k, p) => { try { fs.readFileSync(p); out[k] = "read"; } catch (e) { out[k] = e.code || "error"; } };
const tryWrite = (k, p) => { try { fs.writeFileSync(p, "x"); out[k] = "written"; } catch (e) { out[k] = e.code || "error"; } };
const tryList = (k, p) => { try { fs.readdirSync(p); out[k] = "listed"; } catch (e) { out[k] = e.code || "error"; } };
tryRead("sentinel", t.sentinel);
tryRead("token", t.token);
tryRead("launch", t.launch);
tryRead("database", t.database);
tryRead("otherMedia", t.otherMedia);
tryRead("granted", t.granted);
tryList("profile", t.profile);
tryList("workspace", t.workspace);
tryWrite("writeWorkspace", t.workspace + "\\\\escape.txt");
tryWrite("writeSentinelDir", t.sentinelDir + "\\\\escape.txt");
tryWrite("writeOwn", t.writable + "\\\\ok.txt");
try { const r = cp.spawnSync(process.env.SystemRoot + "\\\\System32\\\\cmd.exe", ["/c", "exit 7"], { stdio: "ignore" }); out.child = r.error ? (r.error.code || "error") : r.status === 7 ? "started" : "status " + r.status; } catch (e) { out.child = e.code || "error"; }
const connect = (k, host, port) => new Promise((done) => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on("connect", () => { out[k] = "connected"; s.destroy(); done(); });
  s.on("timeout", () => { out[k] = "timeout"; s.destroy(); done(); });
  s.on("error", (e) => { out[k] = e.code || "error"; done(); });
});
(async () => {
  await connect("loopback", "127.0.0.1", t.port);
  if (t.lan) await connect("lan", t.lan, t.port);
  console.log(JSON.stringify(out));
})();
`;

test(
  "a contained worker reads only what it is given, writes only its folder and reaches no network",
  { skip: !windows && "Windows AppContainer", timeout: 120_000 },
  async () => {
    const base = await mkdtemp(path.join(tmpdir(), "yamakan-containment-"));
    folders.push(base);
    // A real service workspace: owner-only, with its token and launch link.
    const workspace = path.join(base, "workspace");
    const port = 24361;
    const server = fork(
      fileURLToPath(new URL("../server/main.ts", import.meta.url)),
      [],
      {
        env: {
          ...process.env,
          YAMAKAN_WORKSPACE: workspace,
          YAMAKAN_PORT: String(port),
        },
        silent: true,
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.stdout!.on("data", (c) =>
          String(c).includes("Yamakan is running") ? resolve() : undefined,
        );
        server.once("exit", (code) => reject(new Error(`server ${code}`)));
      });
      // Two imported media objects: one granted to the worker, one not.
      const token = (
        await readFile(path.join(workspace, "token"), "utf8")
      ).trim();
      const call = async (operation: string, parameters: unknown) =>
        (
          await (
            await fetch(`http://127.0.0.1:${port}/api/v1/call`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ apiVersion: 1, operation, parameters }),
            })
          ).json()
        ).result;
      const project = await call("yamakan.project.create", {
        name: "Contained",
      });
      for (const [name, frequency] of [
        ["granted.wav", 440],
        ["other.wav", 660],
      ] as const) {
        const file = path.join(base, name);
        execFileSync(mediaTools().ffmpeg, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${frequency}:duration=1`,
          file,
        ]);
        const r = await fetch(
          `http://127.0.0.1:${port}/api/v1/projects/${project.id}/assets`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "X-Asset-Name": name },
            body: new Uint8Array(await readFile(file)),
          },
        );
        assert.equal(r.status, 200);
      }
      const objects = path.join(workspace, "projects", project.id, "objects");
      const media = (await readdir(objects)).filter((n) => n.endsWith(".wav"));
      assert.equal(media.length, 2);
      const [granted, otherMedia] = media.map((n) => path.join(objects, n));

      // A sentinel outside the workspace, and the worker's own folder.
      const sentinelDir = path.join(base, "elsewhere");
      await mkdir(sentinelDir);
      const sentinel = path.join(sentinelDir, "sentinel.txt");
      await writeFile(sentinel, "SENTINEL-c0ffee");
      const writable = path.join(base, "worker");
      await mkdir(writable);

      // A listener on every interface; the LAN address, if this machine has one.
      const listener = createServer((_, res) => res.end("ok")).listen(
        0,
        "0.0.0.0",
      );
      await once(listener, "listening");
      const listenPort = (listener.address() as { port: number }).port;
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
      const targets = {
        sentinel,
        sentinelDir,
        token: path.join(workspace, "token"),
        launch: path.join(workspace, "launch"),
        database: path.join(workspace, "workspace.sqlite"),
        otherMedia,
        granted,
        profile: process.env.USERPROFILE,
        workspace,
        writable,
        port: listenPort,
        lan,
      };
      try {
        // Control: an uncontained process can do all of it.
        const control = spawnSync(
          process.execPath,
          ["-e", HOSTILE, JSON.stringify(targets)],
          {
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        const free = JSON.parse(control.stdout.trim().split("\n").at(-1)!);
        assert.equal(free.sentinel, "read");
        assert.equal(free.token, "read");
        assert.equal(free.database, "read");
        assert.equal(free.otherMedia, "read");
        assert.equal(free.loopback, "connected");
        if (lan) assert.equal(free.lan, "connected");
        await rm(path.join(workspace, "escape.txt"), { force: true });
        await rm(path.join(sentinelDir, "escape.txt"), { force: true });
        await rm(path.join(writable, "ok.txt"), { force: true });

        // The same script as a contained worker.
        const owner = new ProcessOwner([process.execPath]);
        let stdout = "";
        let result;
        try {
          result = await owner.run({
            executable: process.execPath,
            args: ["-e", HOSTILE, JSON.stringify(targets)],
            cwd: base,
            readable: [granted],
            writable: [writable],
            onStdout: (b) => (stdout += b),
          });
        } finally {
          owner.close();
        }
        const contained = JSON.parse(stdout.trim().split("\n").at(-1)!);
        // Denied: everything it was not given.
        for (const key of [
          "sentinel",
          "token",
          "launch",
          "database",
          "otherMedia",
        ])
          assert.notEqual(contained[key], "read", `${key}: ${contained[key]}`);
        for (const key of ["profile", "workspace"])
          assert.notEqual(
            contained[key],
            "listed",
            `${key}: ${contained[key]}`,
          );
        assert.notEqual(contained.writeWorkspace, "written");
        assert.notEqual(contained.writeSentinelDir, "written");
        assert.notEqual(contained.child, "started", contained.child);
        assert.notEqual(contained.loopback, "connected", contained.loopback);
        if (lan) assert.notEqual(contained.lan, "connected", contained.lan);
        // Allowed: exactly what it was given.
        assert.equal(contained.granted, "read");
        assert.equal(contained.writeOwn, "written");
        assert.equal(result.code, 0, result.stderr);
        assert.ok(!stdout.includes("SENTINEL"));
        // Its grants are gone: an uncontained check of the access lists finds
        // no capability entry left on the input or the folder.
        for (const p of [granted, writable, base]) {
          const acl = execFileSync("icacls", [p], { encoding: "utf8" });
          assert.doesNotMatch(acl, /S-1-15-3-1024-/, p);
        }
      } finally {
        listener.close();
      }
    } finally {
      if (server.exitCode === null) {
        const done = once(server, "exit");
        server.send("shutdown");
        await done;
      }
    }
  },
);
