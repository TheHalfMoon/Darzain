// Parts of MVP journey steps 9 and 10 (docs/E2E_ACCEPTANCE.md): cancelling a
// running conversion ends its FFmpeg worker within the 1 s target, and hard
// kills during a backup and during a conversion leave a workspace that opens
// with no manual unlock, no orphan worker and no phantom result. Not covered
// here: queued and export cancels, cancel/completion races, kills during save
// and render, and kills at native launch seams.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import { toCommandError } from "../core/command/errors.ts";

const windows = process.platform === "win32";
const bases: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );
const exists = (file: string) =>
  stat(file).then(
    (s) => s,
    () => null,
  );
// Polls until the condition holds or the time runs out; returns the outcome.
async function within(ms: number, condition: () => boolean | Promise<boolean>) {
  for (const started = performance.now(); performance.now() - started < ms;) {
    if (await condition()) return true;
    await pause(5);
  }
  return condition();
}

// Three minutes of 720p variable-rate video with audio: its conversion takes
// several seconds, far longer than any window the tests allow a worker to
// outlive its cancel or its service. Made once, cheaply (ultrafast).
let source: Promise<string> | undefined;
function longVfr() {
  source ??= folder().then((base) => {
    const file = path.join(base, "vfr.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1280x720:rate=30:duration=180",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=180",
      "-vf",
      "select='not(mod(n\\,3))+eq(n\\,1)'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "35",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      file,
    ]);
    return file;
  });
  return source;
}

// A project with the long variable-rate clip staged for conversion.
async function stagedWorkspace(name: string) {
  const base = await folder();
  const root = path.join(base, "workspace");
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create(name);
  const staged = await store.stageAsset(
    project.id,
    "vfr.mp4",
    await readFile(await longVfr()),
  );
  assert.equal(staged.probe.variableFrameRate, true);
  return { root, store, project, staged };
}
const attemptDir = (root: string, projectId: string, jobId: string) =>
  path.join(root, "projects", projectId, "exports", jobId, "attempt-1");
type Attempt = {
  state: string;
  pid: number | null;
  error: string | null;
  generation: number;
};
const attempts = (store: ProjectStore, jobId: string) =>
  store.read((db) =>
    db
      .prepare(
        "SELECT state, pid, error, generation FROM attempts WHERE job_id = ? ORDER BY attempt_no",
      )
      .all(jobId),
  ) as Attempt[];
// Waits until the first attempt's FFmpeg is resumed and writing its output.
async function writingPid(
  store: ProjectStore,
  root: string,
  projectId: string,
  jobId: string,
) {
  const partial = path.join(
    attemptDir(root, projectId, jobId),
    "worker",
    "derivative.mp4",
  );
  let pid = 0;
  await within(60000, async () => {
    pid = attempts(store, jobId).find((a) => a.state === "running")?.pid ?? 0;
    return pid > 0 && ((await exists(partial))?.size ?? 0) > 0;
  });
  assert.ok(pid && alive(pid), "FFmpeg is writing its output");
  return { pid, partial };
}

// A forked stand-in service whose messages can be awaited; an early exit or
// a timeout fails the wait instead of hanging the test.
function service(name: string, args: string[]) {
  const messages: unknown[] = [];
  let stderr = "";
  const child = fork(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    args,
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  children.push(child);
  child.on("message", (m) => messages.push(m));
  child.stderr!.on("data", (d) => (stderr += d));
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  return {
    async next<T>(match: (m: any) => T | undefined, ms = 60000): Promise<T> {
      let found: T | undefined;
      await within(ms, () => {
        for (const m of messages)
          if ((found = match(m)) !== undefined) return true;
        if (!running()) throw new Error(`service exited early: ${stderr}`);
        return false;
      });
      if (found === undefined)
        throw new Error(`no message within ${ms} ms: ${stderr}`);
      return found;
    },
    // The kill must land on a live service, never on one that already left.
    async kill() {
      assert.ok(running(), `service still running: ${stderr}`);
      child.kill("SIGKILL");
      await exited;
    },
  };
}

test(
  "cancelling a running conversion ends its FFmpeg worker within the 1 s target",
  { skip: !windows && "Windows workers" },
  async () => {
    const { root, store, project, staged } = await stagedWorkspace("Cancel");
    const supervisor = new JobSupervisor(store);
    try {
      await supervisor.start();
      const job = await supervisor.submitDerivative(project.id, staged);
      const { pid } = await writingPid(store, root, project.id, job.id);
      const started = performance.now();
      supervisor.cancel(job.id);
      const gone = await within(5000, () => !alive(pid));
      const elapsed = performance.now() - started;
      assert.ok(gone, "FFmpeg exited");
      assert.ok(elapsed <= 1000, `exited after ${Math.round(elapsed)} ms`);
      assert.ok(
        await within(
          10000,
          () => supervisor.status(job.id).state === "CANCELLED",
        ),
        supervisor.status(job.id).state,
      );
      // No result: nothing attached, and the attempt's files are removed.
      assert.equal((await store.load(project.id)).assets.length, 0);
      assert.ok(
        await within(
          10000,
          async () => !(await exists(attemptDir(root, project.id, job.id))),
        ),
        "the cancelled attempt's files are removed",
      );
    } finally {
      await supervisor.close();
      store.close();
      closeWorkers();
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

  const child = service("t9-backup-child.ts", [root, home]);
  await child.next((m) => (m === "copied" ? true : undefined));
  // The service being killed really holds the lock.
  await assert.rejects(
    acquireServiceLock(root),
    (e: unknown) => toCommandError(e).code === "BUSY",
  );
  await child.kill();

  // No manual unlock: the operating system released the service lock.
  const lock = await acquireServiceLock(root);
  const reopened = new ProjectStore(root);
  try {
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
  } finally {
    reopened.close();
    lock.release();
  }
});

test(
  "a service killed mid-conversion leaves no worker or partial output, and the next start converts and attaches the asset once",
  { skip: !windows && "Windows workers" },
  async () => {
    const { root, store, project, staged } = await stagedWorkspace(
      "Interrupted conversion",
    );
    store.close();
    closeWorkers();

    const child = service("t9-convert-service.ts", [
      root,
      project.id,
      JSON.stringify(staged),
    ]);
    const jobId = await child.next<string>((m) => m?.jobId);
    const ownerPid = await child.next<number>((m) => m?.ownerPid);
    const observer = new ProjectStore(root);
    let found: { pid: number; partial: string };
    try {
      await observer.initialize();
      found = await writingPid(observer, root, project.id, jobId);
    } finally {
      observer.close();
    }
    const { pid, partial } = found;
    await child.kill();
    // The remaining conversion takes seconds; an orphan would still be alive.
    assert.ok(
      await within(1000, () => !alive(pid) && !alive(ownerPid)),
      `FFmpeg ${alive(pid) ? "outlived" : "died with"} its service; procd ${alive(ownerPid) ? "outlived" : "died with"} it`,
    );
    assert.ok(await exists(partial), "the partial output survived the kill");

    // A real restart: lock, a freshly opened store, a new supervisor.
    const lock = await acquireServiceLock(root);
    const restarted = new ProjectStore(root);
    const supervisor = new JobSupervisor(restarted);
    try {
      await restarted.initialize();
      await supervisor.start();
      assert.equal(
        await exists(attemptDir(root, project.id, jobId)),
        null,
        "the interrupted attempt's files are removed at start",
      );
      await within(180000, () =>
        ["COMPLETED", "FAILED", "CANCELLED"].includes(
          supervisor.status(jobId).state,
        ),
      );
      const done = supervisor.status(jobId);
      assert.equal(done.state, "COMPLETED", done.error ?? "");
      const history = attempts(restarted, jobId);
      assert.equal(history[0].state, "failed");
      assert.match(history[0].error ?? "", /restart/);
      assert.equal(history.at(-1)!.state, "succeeded");
      assert.ok(history.at(-1)!.generation > history[0].generation);
      // The converted asset joined the project exactly once.
      const head = await restarted.load(project.id);
      assert.equal(head.assets.length, 1, JSON.stringify(head.assets));
      assert.equal(head.assets[0].name, "vfr.mp4");
      assert.notEqual(head.assets[0].hash, staged.asset.hash);
    } finally {
      await supervisor.close();
      restarted.close();
      lock.release();
    }
  },
);
