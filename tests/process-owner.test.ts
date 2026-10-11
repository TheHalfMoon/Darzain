import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
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
        seen.keys.every((k: string) => /^(SystemRoot|TEMP|TMP)$/i.test(k)),
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

async function service(marker: string) {
  const child: ChildProcess = fork(
    fileURLToPath(new URL("./fixtures/t4-service.ts", import.meta.url)),
    [marker],
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
        /owner exited|launch failed/,
      );
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(withMarker(marker), [], "no suspended worker survives");
    } finally {
      delete process.env.YAMAKAN_PROCD_FAULT;
      owner.close();
    }
  },
);
