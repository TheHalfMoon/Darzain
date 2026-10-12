import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessOwner } from "../core/process/owner.ts";

const windows = process.platform === "win32";
const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);
async function folder() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-sandbox-"));
  bases.push(base);
  return base;
}
const appears = async (file: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;)
    if (existsSync(file)) return true;
    else await new Promise((r) => setTimeout(r, 200));
  return existsSync(file);
};
// The folder's mandatory label as icacls reports it (none = Medium).
const label = (dir: string) =>
  /Mandatory Label\\(\w+) Mandatory Level/.exec(
    execFileSync("icacls", [dir], { encoding: "utf8", windowsHide: true }),
  )?.[1] ?? null;

test(
  "a worker cannot start a process outside its job through WMI (the T4a release blocker)",
  { skip: !windows && "Windows workers" },
  async () => {
    const dir = await folder();
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // Win32_Process.Create starts the process from the WMI service, outside
    // any job of the caller.
    const escape = (marker: string) => [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = 'cmd.exe /c echo escaped > "${marker}"'}`,
    ];
    // Control: an ordinary process of this account can, so the escape is
    // real on this machine and a refusal below is the sandbox's doing.
    const control = path.join(dir, "control.txt");
    spawnSync(powershell, escape(control), { windowsHide: true });
    assert.ok(
      await appears(control, 15000),
      "WMI starts a process for an ordinary process",
    );
    const sandboxed = path.join(dir, "sandboxed.txt");
    const owner = new ProcessOwner([powershell]);
    try {
      const result = await owner.run({
        executable: powershell,
        args: escape(sandboxed),
        cwd: dir,
        stderrLimit: 8000,
      });
      assert.match(result.stderr, /PermissionDenied|Access/);
      assert.equal(await appears(sandboxed, 8000), false, "no escape");
    } finally {
      owner.close();
    }
  },
);

test(
  "a worker writes only to the folders it was given, and their label is restored",
  { skip: !windows && "Windows workers" },
  async () => {
    const dir = await folder();
    const out = path.join(dir, "out");
    const other = path.join(dir, "other");
    await mkdir(out);
    await mkdir(other);
    const owner = new ProcessOwner([process.execPath]);
    let printed = "";
    try {
      const result = await owner.run({
        executable: process.execPath,
        args: [
          "-e",
          `const fs = require("fs");
           const tryWrite = (f) => { try { fs.writeFileSync(f, "x"); return "ok"; } catch (e) { return e.code; } };
           process.stdout.write(tryWrite(process.argv[1]) + " " + tryWrite(process.argv[2]));`,
          path.join(out, "allowed.txt"),
          path.join(other, "refused.txt"),
        ],
        cwd: dir,
        writable: [out],
        onStdout: (b) => (printed += b),
      });
      assert.equal(result.code, 0, result.stderr);
    } finally {
      owner.close();
    }
    assert.equal(printed, "ok EPERM");
    assert.equal(await readFile(path.join(out, "allowed.txt"), "utf8"), "x");
    assert.equal(existsSync(path.join(other, "refused.txt")), false);
    // While it ran the folder was labelled Low; afterwards it is back to
    // the default (no label), so later low-integrity programs cannot write.
    assert.equal(label(out), null);
  },
);

test(
  "a link or junction is never accepted as a writable folder",
  { skip: !windows && "Windows workers" },
  async () => {
    const dir = await folder();
    const target = path.join(dir, "target");
    await mkdir(target);
    const link = path.join(dir, "link");
    await symlink(target, link, "junction");
    const owner = new ProcessOwner([process.execPath]);
    try {
      await assert.rejects(
        owner.run({
          executable: process.execPath,
          args: ["-e", "0"],
          cwd: dir,
          writable: [link],
        }),
        /missing or is a link/,
      );
    } finally {
      owner.close();
    }
    assert.equal(label(target), null);
  },
);
