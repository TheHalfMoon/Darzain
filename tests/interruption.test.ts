// MVP journey steps 9 and 10 (docs/E2E_ACCEPTANCE.md): a cancelled worker
// exits within the 1 s target, and hard kills during a backup and during a
// constant-rate conversion leave a workspace that opens with no manual
// unlock, no orphan FFmpeg and no phantom result.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { acquireServiceLock } from "../core/service-lock.ts";
import {
  backupWorkspace,
  listBackups,
  restoreFromHome,
} from "../core/recovery.ts";
import { ProcessOwner } from "../core/process/owner.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import { toCommandError } from "../core/command/errors.ts";

const windows = process.platform === "win32";
const bases: string[] = [];
after(async () => {
  closeWorkers();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});
async function folder() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-interrupt-"));
  bases.push(base);
  return base;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test(
  "a cancelled worker has exited within the 1 s target",
  { skip: !windows && "Windows workers" },
  async () => {
    const owner = new ProcessOwner([process.execPath]);
    try {
      const controller = new AbortController();
      let pid = 0;
      const running = owner.run({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: tmpdir(),
        signal: controller.signal,
        onCreated: (p) => {
          pid = p;
        },
      });
      while (!pid) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(alive(pid), "the worker is running");
      const started = performance.now();
      controller.abort();
      await running.catch(() => null);
      while (alive(pid) && performance.now() - started < 5000)
        await new Promise((r) => setTimeout(r, 5));
      const elapsed = performance.now() - started;
      assert.equal(alive(pid), false);
      assert.ok(elapsed <= 1000, `exited after ${Math.round(elapsed)} ms`);
    } finally {
      owner.close();
    }
  },
);

test("a backup killed after its database copy leaves an incomplete backup and an intact workspace", async () => {
  const base = await folder();
  const root = path.join(base, "workspace");
  const home = path.join(base, "recovery");
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Interrupted backup");
  const png = path.join(base, "still.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=teal:s=64x64", "-frames:v", "1", png]);
  await store.importAsset(project.id, "still.png", await readFile(png));
  const before = await store.load(project.id);
  store.close();
  closeWorkers();

  const child = fork(fixture("t9-backup-child.ts"), [root, home], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const [message] = await once(child, "message");
  assert.equal(message, "copied");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;

  // No manual unlock: the operating system released the service lock.
  const lock = await acquireServiceLock(root);
  const reopened = new ProjectStore(root);
  await reopened.initialize();
  const head = await reopened.load(project.id);
  assert.equal(head.revision, before.revision);
  assert.deepEqual(head.assets, before.assets);
  // The half-made backup is listed as incomplete and cannot be restored.
  const listed = await listBackups(home);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].complete, false);
  await assert.rejects(
    restoreFromHome(home, listed[0].backupId),
    (e: unknown) => toCommandError(e).code === "VALIDATION",
  );
  // The next backup completes normally.
  const made = await backupWorkspace(reopened, home);
  assert.equal(made.damaged, 0);
  assert.equal((await listBackups(home)).filter((b) => b.complete).length, 1);
  reopened.close();
  lock.release();
});

test(
  "a service killed mid-conversion leaves no FFmpeg, and the next start converts and attaches the asset once",
  { skip: !windows && "Windows workers" },
  async () => {
    const base = await folder();
    const root = path.join(base, "workspace");
    const store = new ProjectStore(root);
    await store.initialize();
    const project = await store.create("Interrupted conversion");
    // Long enough to be caught running: 30 s of 720p variable-rate video.
    const vfr = path.join(base, "vfr.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1280x720:rate=30:duration=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=30",
      "-vf",
      "select='not(mod(n\\,3))+eq(n\\,1)'",
      "-fps_mode",
      "vfr",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      vfr,
    ]);
    const staged = await store.stageAsset(
      project.id,
      "vfr.mp4",
      await readFile(vfr),
    );
    assert.equal(staged.probe.variableFrameRate, true);
    store.close();
    closeWorkers();

    const child = fork(
      fixture("t9-convert-service.ts"),
      [root, project.id, JSON.stringify(staged)],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const [{ jobId }] = (await once(child, "message")) as [{ jobId: string }];
    const observer = new ProjectStore(root);
    await observer.initialize();
    const attempts = () =>
      observer.read((db) =>
        db
          .prepare(
            "SELECT state, pid, error, generation FROM attempts WHERE job_id = ? ORDER BY attempt_no",
          )
          .all(jobId),
      ) as {
        state: string;
        pid: number | null;
        error: string | null;
        generation: number;
      }[];
    let pid = 0;
    for (let t = 0; t < 30000 && !pid; t += 20) {
      pid = attempts().find((a) => a.state === "running")?.pid ?? 0;
      if (!pid) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pid && alive(pid), "FFmpeg is converting");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    for (let t = 0; t < 5000 && alive(pid); t += 50)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, "FFmpeg died with its service");

    const supervisor = new JobSupervisor(observer);
    await supervisor.start();
    let done = supervisor.status(jobId);
    for (let t = 0; t < 180000; t += 100) {
      done = supervisor.status(jobId);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(done.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(done.state, "COMPLETED", done.error ?? "");
    const history = attempts();
    assert.equal(history[0].state, "failed");
    assert.match(history[0].error ?? "", /restart/);
    assert.equal(history.at(-1)!.state, "succeeded");
    // The converted asset joined the project exactly once.
    const head = await observer.load(project.id);
    assert.equal(
      head.assets.filter((a) => a.name === "vfr.mp4").length,
      1,
      JSON.stringify(head.assets.map((a) => a.name)),
    );
    await supervisor.close();
    observer.close();
  },
);
