import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import type { SupervisorOptions } from "../core/jobs.ts";
import { CommandError } from "../core/command/errors.ts";

async function workspace(frames = 30) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-jobs-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Jobs");
  const project = await store.save(
    {
      ...created,
      width: 320,
      height: 180,
      clips: [
        {
          id: crypto.randomUUID(),
          trackId: created.tracks[0].id,
          assetId: null,
          startFrame: 0,
          durationFrames: frames,
          sourceFrame: 0,
          title: "Durable job",
        },
      ],
    },
    0,
  );
  return { root, store, project };
}
async function settled(supervisor: JobSupervisor, jobId: string, ms = 60000) {
  for (let t = 0; t < ms; t += 50) {
    const job = supervisor.status(jobId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not settle`);
}
const attempts = (store: ProjectStore, jobId: string) =>
  store.read((db) =>
    db
      .prepare(
        "SELECT attempt_no, generation, state, pid, error FROM attempts WHERE job_id = ? ORDER BY attempt_no",
      )
      .all(jobId),
  ) as {
    attempt_no: number;
    generation: number;
    state: string;
    pid: number | null;
    error: string | null;
  }[];
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("an export job renders through an owned worker and records its attempt", async () => {
  const { store, project } = await workspace();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submit(project.id, "first");
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  assert.equal(done.artifact, `exports/${job.id}/render.mp4`);
  assert.ok(
    await exists(await store.file(project.id, "exports", job.id, "render.mp4")),
  );
  const [attempt] = attempts(store, job.id);
  assert.equal(attempt.state, "succeeded");
  assert.ok(attempt.pid && attempt.pid > 0, "worker identity was recorded");
  assert.deepEqual(
    await readdir(await store.file(project.id, "exports", job.id)),
    ["render.mp4"],
    "attempt staging is removed",
  );
  assert.equal(
    (await supervisor.submit(project.id, "first")).id,
    job.id,
    "idempotent",
  );
  await supervisor.close();
  store.close();
});

test("a corrupt job payload is quarantined and does not block other jobs", async () => {
  const { store, project } = await workspace();
  store.transaction((db) =>
    db
      .prepare(
        "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'export', ?, ?, 'bad', '{\"format\":\"evil/9\"}', 'queued')",
      )
      .run(crypto.randomUUID(), project.id, project.revision),
  );
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const good = await supervisor.submit(project.id, "good");
  assert.equal((await settled(supervisor, good.id)).state, "COMPLETED");
  const bad = supervisor.list().find((j) => j.id !== good.id)!;
  assert.equal(bad.state, "FAILED");
  assert.match(bad.error!, /quarantined/);
  await supervisor.close();
  store.close();
});

test("finished history never exhausts admission; active work is capped", async () => {
  const { store, project } = await workspace();
  store.transaction((db) => {
    const insert = db.prepare(
      "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'export', ?, 0, ?, '{}', ?)",
    );
    for (let i = 0; i < 10_001; i++)
      insert.run(
        crypto.randomUUID(),
        project.id,
        `old-${i}`,
        i % 2 ? "succeeded" : "failed",
      );
  });
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submit(project.id, "after-history");
  assert.equal((await settled(supervisor, job.id)).state, "COMPLETED");
  // 128 active jobs (as if running) fill the admission limit.
  store.transaction((db) => {
    const insert = db.prepare(
      "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'export', ?, 0, ?, '{}', 'running')",
    );
    for (let i = 0; i < 128; i++)
      insert.run(crypto.randomUUID(), project.id, `busy-${i}`);
  });
  await assert.rejects(
    supervisor.submit(project.id, "one-too-many"),
    (e: unknown) => e instanceof CommandError && e.code === "LIMIT_EXCEEDED",
  );
  await supervisor.close();
  store.close();
});

test("cancel and completion race: the database decides, and losers leave no artifact", async () => {
  const { store, project } = await workspace();
  let cancelInside: string | null = null;
  const options: SupervisorOptions = {
    fault: (point, jobId) => {
      if (point === "before-succeed" && jobId === cancelInside)
        supervisor.cancel(jobId);
    },
  };
  const supervisor = new JobSupervisor(store, options);
  await supervisor.start();
  const raced = await supervisor.submit(project.id, "cancel-wins");
  cancelInside = raced.id;
  const lost = await settled(supervisor, raced.id);
  assert.equal(lost.state, "CANCELLED");
  assert.equal(lost.artifact, null);
  assert.equal(
    await exists(
      await store.file(project.id, "exports", raced.id, "render.mp4"),
    ),
    false,
  );
  const finished = await supervisor.submit(project.id, "complete-wins");
  assert.equal((await settled(supervisor, finished.id)).state, "COMPLETED");
  const late = supervisor.cancel(finished.id);
  assert.equal(late.state, "COMPLETED", "a completed job stays completed");
  assert.ok(
    await exists(
      await store.file(project.id, "exports", finished.id, "render.mp4"),
    ),
  );
  await supervisor.close();
  store.close();
});

test("an attempt fenced by a newer generation cannot publish", async () => {
  const { store, project } = await workspace();
  let fenced = false;
  const supervisor = new JobSupervisor(store, {
    fault: (point) => {
      // A newer service run takes over while this attempt is validating.
      if (point === "before-succeed") {
        store.transaction((db) =>
          db.prepare("UPDATE supervisor SET generation = generation + 1").run(),
        );
        fenced = true;
      }
    },
  });
  await supervisor.start();
  const job = await supervisor.submit(project.id, "fenced");
  for (let t = 0; t < 30000 && !fenced; t += 50)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(fenced, "the attempt reached publication");
  await new Promise((r) => setTimeout(r, 200));
  await supervisor.close();
  assert.notEqual(supervisor.status(job.id).state, "COMPLETED");
  assert.equal(
    attempts(store, job.id)[0].state,
    "validating",
    "the fenced attempt changed nothing",
  );
  assert.equal(
    await exists(await store.file(project.id, "exports", job.id, "render.mp4")),
    false,
  );
  // The newer run reconciles and completes the job.
  const next = new JobSupervisor(store);
  await next.start();
  assert.equal((await settled(next, job.id)).state, "COMPLETED");
  await next.close();
  store.close();
});

test("a graceful shutdown re-queues running work for the next start", async () => {
  const { store, project } = await workspace(3000);
  const first = new JobSupervisor(store);
  await first.start();
  const job = await first.submit(project.id, "resume");
  for (
    let t = 0;
    t < 30000 && attempts(store, job.id)[0]?.state !== "running";
    t += 20
  )
    await new Promise((r) => setTimeout(r, 20));
  await first.close();
  assert.equal(first.status(job.id).detail, "queued");
  const second = new JobSupervisor(store);
  await second.start();
  assert.equal((await settled(second, job.id)).state, "COMPLETED");
  assert.deepEqual(
    attempts(store, job.id).map((a) => a.state),
    ["failed", "succeeded"],
  );
  await second.close();
  store.close();
});

test(
  "a service killed mid-render leaves no FFmpeg, and the next start reconciles and finishes",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, store, project } = await workspace(3000);
    store.close();
    const child = fork(
      fileURLToPath(new URL("./fixtures/t5-service.ts", import.meta.url)),
      [root, project.id],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const [{ jobId }] = (await once(child, "message")) as [{ jobId: string }];
    const observer = new ProjectStore(root);
    await observer.initialize();
    let pid = 0;
    for (let t = 0; t < 30000 && !pid; t += 20) {
      const running = attempts(observer, jobId).find(
        (a) => a.state === "running",
      );
      pid = running?.pid ?? 0;
      if (!pid) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pid && alive(pid), "FFmpeg is running");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    for (let t = 0; t < 5000 && alive(pid); t += 50)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, "FFmpeg died with its service");
    const supervisor = new JobSupervisor(observer);
    await supervisor.start();
    const done = await settled(supervisor, jobId);
    assert.equal(done.state, "COMPLETED", done.error ?? "");
    const history = attempts(observer, jobId);
    assert.equal(history[0].state, "failed");
    assert.match(history[0].error!, /restart/);
    assert.equal(history.at(-1)!.state, "succeeded");
    assert.ok(history.at(-1)!.generation > history[0].generation);
    await supervisor.close();
    observer.close();
  },
);
