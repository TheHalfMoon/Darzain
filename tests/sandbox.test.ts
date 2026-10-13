import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ProcessOwner } from "../core/process/owner.ts";

const windows = process.platform === "win32";
const workerProbe = fileURLToPath(
  new URL("../native/procd/target/release/worker-probe.exe", import.meta.url),
);
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
  "a worker cannot use WMI to escape (PowerShell launch denial or WMI refusal)",
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
    // any job of the caller. A failure stops the script with exit code 1.
    const escape = (marker: string) => [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = 'cmd.exe /c echo escaped > "${marker}"'}`,
    ];
    // The sandboxed marker goes in a folder the worker may write, so a
    // process started for it (at its own integrity) could have written it.
    const out = path.join(dir, "out");
    await mkdir(out);
    // Control: an ordinary process of this account can, so the escape is
    // real on this machine and a refusal below is the sandbox's doing.
    const control = path.join(dir, "control.txt");
    spawnSync(powershell, escape(control), { windowsHide: true });
    assert.ok(
      await appears(control, 15000),
      "WMI starts a process for an ordinary process",
    );
    const sandboxed = path.join(out, "sandboxed.txt");
    const owner = new ProcessOwner([powershell]);
    try {
      const result = await owner.run({
        executable: powershell,
        args: escape(sandboxed),
        cwd: dir,
        writable: [out],
        stderrLimit: 8000,
      });
      // WBEM_E_ACCESS_DENIED: the call itself is refused.
      assert.notEqual(result.code, 0);
      if (result.stderr.trim()) {
        assert.match(
          result.stderr,
          /CIM resource was not available|0x80041003|WSAStartup/i,
        );
      }
      // The stricter AppContainer may refuse PowerShell startup before WMI
      // is contacted. In that case this test proves no escape, not a WMI
      // authorization decision; native worker child-spawn denial is tested
      // separately in process-owner.test.ts.
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
    const owner = new ProcessOwner([workerProbe]);
    let printed = "";
    try {
      const result = await owner.run({
        executable: workerProbe,
        args: [
          "write",
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
    assert.equal(printed.trim(), "ok denied");
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
    const owner = new ProcessOwner([workerProbe]);
    try {
      await assert.rejects(
        owner.run({
          executable: workerProbe,
          args: ["exit"],
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

test(
  "folders are restored when the service closes mid-run, and a shared folder stays writable until its last worker exits",
  { skip: !windows && "Windows workers" },
  async () => {
    const dir = await folder();
    const shared = path.join(dir, "shared");
    const held = path.join(dir, "held");
    await mkdir(shared);
    await mkdir(held);
    const owner = new ProcessOwner([workerProbe]);
    try {
      // Two workers share a folder: the first exits at once; the second
      // writes after that and must still be allowed.
      let late = "";
      const first = owner.run({
        executable: workerProbe,
        args: ["exit"],
        cwd: dir,
        writable: [shared],
      });
      const second = owner.run({
        executable: workerProbe,
        args: ["write-later", path.join(shared, "late.txt")],
        cwd: dir,
        writable: [shared],
        onStdout: (b) => (late += b),
      });
      await first;
      await second;
      assert.equal(late, "ok");
      assert.equal(label(shared), null, "restored after the last one");
      // A long worker holds a folder; the service closes.
      let created!: () => void;
      const started = new Promise<void>((r) => (created = r));
      const running = owner
        .run({
          executable: workerProbe,
          args: ["sleep"],
          cwd: dir,
          writable: [held],
          onCreated: () => created(),
        })
        .catch(() => null);
      await started;
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(label(held), "Low", "labelled while it runs");
      owner.close();
      await running;
      let restored = false;
      for (let i = 0; i < 50 && !restored; i++) {
        restored = label(held) === null;
        if (!restored) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(restored, "restored when the service closes");
    } finally {
      owner.close();
    }
  },
);

test(
  "a published render keeps only the main stream, with the workspace's access, not the worker's",
  { skip: !windows && "Windows access control" },
  async () => {
    const dir = await folder();
    const { restrictToOwner, readableByOtherAccounts } =
      await import("../core/process/access.ts");
    const { keepMainStream } = await import("../core/render.ts");
    await restrictToOwner(dir, "dir");
    const written = path.join(dir, "render.partial.mp4");
    const kept = path.join(dir, "render.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(written, "video bytes");
    await writeFile(`${written}:payload`, "hidden");
    // What a compromised worker could do to the file it owns.
    execFileSync(
      "icacls",
      [
        written,
        "/inheritance:r",
        "/grant",
        "*S-1-1-0:F",
        "/grant",
        `${process.env.USERNAME}:F`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    assert.equal(await readableByOtherAccounts(written), true, "control");
    await keepMainStream(written, kept);
    assert.equal(await readFile(kept, "utf8"), "video bytes");
    assert.equal(existsSync(`${kept}:payload`), false, "no alternate stream");
    assert.equal(existsSync(written), false);
    assert.equal(await readableByOtherAccounts(kept), false);
  },
);

test(
  "a worker that opens its own folder to everyone leaves nothing readable by other accounts",
  { skip: !windows && "Windows access control" },
  async () => {
    const { restrictToOwner, readableByOtherAccounts } =
      await import("../core/process/access.ts");
    const { keepMainStream } = await import("../core/render.ts");
    const dir = await folder();
    await restrictToOwner(dir, "dir");
    const work = path.join(dir, "worker");
    await mkdir(work);
    const written = path.join(work, "render.partial.mp4");
    const owner = new ProcessOwner([workerProbe]);
    let out = "";
    try {
      const result = await owner.run({
        executable: workerProbe,
        args: ["acl", written, work],
        cwd: dir,
        writable: [work],
        onStdout: (b) => (out += b.toString("utf8")),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        out.trim(),
        "denied",
        "worker has no WRITE_DAC even for unchanged ACL",
      );
    } finally {
      owner.close();
    }
    // Its output was written; procd reset the folder to plain inheritance
    // when the worker exited.
    assert.equal(await readableByOtherAccounts(work), false);
    assert.equal(await readableByOtherAccounts(written), false);
    // The service's copy is made outside the worker's folder.
    const kept = path.join(dir, "render.mp4");
    await keepMainStream(written, kept);
    assert.equal(await readableByOtherAccounts(kept), false);
  },
);

test(
  "a folder that cannot be restored after a run fails the run instead of passing silently",
  { skip: !windows && "Windows workers" },
  async () => {
    const dir = await folder();
    const work = path.join(dir, "worker");
    await mkdir(work);
    const owner = new ProcessOwner([workerProbe]);
    try {
      let created!: () => void;
      const started = new Promise<void>((r) => (created = r));
      const running = owner.run({
        executable: workerProbe,
        args: ["sleep-ms", "1000"],
        cwd: dir,
        writable: [work],
        onCreated: () => created(),
      });
      await started;
      // The folder disappears before the worker exits: procd cannot put it
      // back to the workspace's access, and says so.
      await rm(work, { recursive: true, force: true });
      await assert.rejects(running, { code: "RECOVERY_REQUIRED" });
    } finally {
      owner.close();
    }
  },
);
