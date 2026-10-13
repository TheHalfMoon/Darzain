import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProcessOwner } from "../core/process/owner.ts";
import { CommandError } from "../core/command/errors.ts";

const windows = process.platform === "win32";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 5000) {
  for (let t = 0; t < ms; t += 50) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
// Any process (running or suspended) whose command line carries the marker.
function withMarker(marker: string) {
  const out = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $env:MARKER + '*') -and $_.Name -eq 'node.exe' } | ForEach-Object { $_.ProcessId }",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MARKER: marker },
    },
  ).stdout;
  return out.split(/\s+/).filter(Boolean).map(Number);
}
async function noMarker(marker: string, exclude: number[] = []) {
  for (let t = 0; t < 5000; t += 250) {
    if (!withMarker(marker).some((pid) => !exclude.includes(pid))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const node = (code: string, ...args: string[]) => ({
  executable: process.execPath,
  args: ["-e", code, ...args],
  cwd: tmpdir(),
});

test(
  "arguments reach the worker exactly, with no shell interpretation",
  { skip: !windows },
  async () => {
    const owner = new ProcessOwner([process.execPath]);
    try {
      const tricky = [
        "plain",
        "two words",
        'quote"inside',
        "trailing\\",
        'back\\slash\\"quote',
        "",
        "tab\there",
        "عربي · ünïcode",
        "%PATH%",
        "&|<>^!",
        "$(whoami)",
      ];
      let out = "";
      const result = await owner.run({
        ...node(
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          ...tricky,
        ),
        onStdout: (b) => (out += b.toString("utf8")),
      });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(out), tricky);
    } finally {
      owner.close();
    }
  },
);

test(
  "workers get a minimal environment and stay suspended until their identity is recorded",
  { skip: !windows },
  async () => {
    process.env.YAMAKAN_TEST_SECRET = "must-not-leak";
    const owner = new ProcessOwner([process.execPath]);
    try {
      let recordedAt = 0;
      let out = "";
      const result = await owner.run({
        ...node(
          "process.stdout.write(JSON.stringify({ keys: Object.keys(process.env), at: Date.now() }))",
        ),
        onCreated: async () => {
          await new Promise((r) => setTimeout(r, 400));
          recordedAt = Date.now();
        },
        onStdout: (b) => (out += b.toString("utf8")),
      });
      assert.equal(result.code, 0);
      const seen = JSON.parse(out);
      assert.ok(
        seen.at >= recordedAt,
        "the worker ran only after onCreated finished",
      );
      assert.ok(!seen.keys.includes("YAMAKAN_TEST_SECRET"));
      assert.ok(
        // The profile locations are needed to create an AppContainer process
        // (paths the container cannot read); nothing else passes.
        seen.keys.every((k: string) =>
          /^(SystemRoot|TEMP|TMP|USERPROFILE|LOCALAPPDATA)$/i.test(k),
        ),
        seen.keys.join(","),
      );
    } finally {
      delete process.env.YAMAKAN_TEST_SECRET;
      owner.close();
    }
  },
);

test(
  "cancellation terminates the worker's job",
  { skip: !windows },
  async () => {
    const owner = new ProcessOwner([process.execPath]);
    try {
      const controller = new AbortController();
      let pid = 0;
      const running = owner.run({
        ...node("setInterval(() => {}, 1000)"),
        signal: controller.signal,
        onCreated: (p) => {
          pid = p;
        },
      });
      setTimeout(() => controller.abort(), 300);
      const result = await running;
      assert.notEqual(result.code, 0);
      assert.ok(await gone(pid), "the worker is gone");
    } finally {
      owner.close();
    }
  },
);

test(
  "only allowlisted executables can be launched",
  { skip: !windows },
  async () => {
    const owner = new ProcessOwner([process.execPath]);
    try {
      await assert.rejects(
        owner.run({
          executable: "C:\\Windows\\System32\\cmd.exe",
          args: ["/c", "echo"],
          cwd: tmpdir(),
        }),
        (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
      );
    } finally {
      owner.close();
    }
  },
);

async function service(marker: string, mode = "run") {
  const child: ChildProcess = fork(
    fileURLToPath(new URL("./fixtures/t4-service.ts", import.meta.url)),
    [marker, mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
  );
  const [ids] = (await once(child, "message")) as [
    { worker: number; owner: number },
  ];
  return { child, ...ids };
}

test(
  "killing the service ends its workers (no orphans)",
  { skip: !windows },
  async () => {
    const marker = `yamakan-orphan-${crypto.randomUUID()}`;
    const { child, worker, owner } = await service(marker);
    assert.ok(alive(worker));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.ok(await gone(worker), "worker ended with its service");
    assert.ok(await gone(owner), "the process owner ended with its service");
    assert.deepEqual(withMarker(marker), []);
  },
);

test(
  "killing the process owner ends its workers",
  { skip: !windows },
  async () => {
    const marker = `yamakan-orphan-${crypto.randomUUID()}`;
    const { child, worker, owner } = await service(marker);
    try {
      process.kill(owner, "SIGKILL");
      assert.ok(await gone(worker), "worker ended with its owner");
      // The stand-in service itself carries the marker and is still running.
      assert.deepEqual(
        withMarker(marker).filter((pid) => pid !== child.pid),
        [],
      );
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test(
  "an owner that dies between creation and resume leaves no suspended worker",
  { skip: !windows },
  async () => {
    const marker = `yamakan-orphan-${crypto.randomUUID()}`;
    process.env.YAMAKAN_PROCD_FAULT = "after-create";
    const owner = new ProcessOwner([process.execPath]);
    try {
      await assert.rejects(
        owner.run(node("setInterval(() => {}, 1000)", marker)),
        /owner exited/,
      );
      assert.ok(await noMarker(marker), "no suspended worker survives");
    } finally {
      delete process.env.YAMAKAN_PROCD_FAULT;
      owner.close();
    }
  },
);

test(
  "killing the service while it records a suspended worker's identity leaves no worker",
  { skip: !windows },
  async () => {
    const marker = `yamakan-orphan-${crypto.randomUUID()}`;
    const { child, worker } = await service(marker, "hang");
    assert.ok(alive(worker), "the worker exists, still suspended");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.ok(await gone(worker));
    assert.ok(await noMarker(marker));
  },
);

test(
  "a script without a server waits for its workers and exits",
  { skip: !windows },
  () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/t4-bare.ts", import.meta.url))],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "done");
  },
);

test(
  "a worker cannot start child processes inside its job",
  { skip: !windows },
  async () => {
    const owner = new ProcessOwner([process.execPath]);
    try {
      let out = "";
      const result = await owner.run({
        ...node(
          // No stdio pipes: the attempt meets the job limit, not pipe creation
          // (Node's pipes stall inside an AppContainer).
          "const r = require('child_process').spawnSync(process.execPath, ['-e', '1'], { stdio: 'ignore' }); process.stdout.write(String(r.error ? r.error.code : r.status))",
        ),
        onStdout: (b) => (out += b.toString("utf8")),
      });
      assert.equal(result.code, 0);
      assert.notEqual(out, "0", "the child must not run");
    } finally {
      owner.close();
    }
  },
);

test(
  "procd rejects malformed requests without dying and accepts zero-argument spawns",
  { skip: !windows },
  async () => {
    const procd = spawn(
      fileURLToPath(
        new URL(
          "../native/procd/target/release/yamakan-procd.exe",
          import.meta.url,
        ),
      ),
      [process.execPath],
      { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
    );
    const lines: string[] = [];
    createInterface({ input: procd.stdout! }).on("line", (l) => lines.push(l));
    const waitFor = async (predicate: (l: string) => boolean) => {
      for (let t = 0; t < 5000; t += 20) {
        const hit = lines.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout; saw ${lines.join(" | ")}`);
    };
    const hex = (s: string) => Buffer.from(s).toString("hex");
    try {
      await waitFor((l) => l === "READY");
      procd.stdin!.write("SPAWN\tbad1\ta\u00e9\t00\t0\t0\t0\n");
      await waitFor((l) => l.startsWith("ERROR\tbad1"));
      procd.stdin!.write("SPAWN\tbad2\tzz\t00\t0\t0\t0\n");
      await waitFor((l) => l.startsWith("ERROR\tbad2"));
      procd.stdin!.write(
        // memory 0, no writable folders, no readable paths, no arguments
        `SPAWN\tok1\t${hex(process.execPath)}\t${hex(tmpdir())}\t0\t0\t0\t0\n`,
      );
      await waitFor((l) => l.startsWith("CREATED\tok1"));
      procd.stdin!.write("KILL\tok1\n");
      await waitFor((l) => l.startsWith("EXITED\tok1"));
      const exited = once(procd, "exit");
      procd.stdin!.write("x".repeat(300 * 1024));
      procd.stdin!.write("\n");
      await exited;
    } finally {
      procd.kill();
    }
  },
);
