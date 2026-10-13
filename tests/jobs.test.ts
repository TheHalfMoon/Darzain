import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import type { SupervisorOptions } from "../core/jobs.ts";
import { CommandError } from "../core/command/errors.ts";
import { workers } from "../core/process/workers.ts";

async function workspace(frames = 30, width = 320, height = 180) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-jobs-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Jobs");
  const project = await store.save(
    {
      ...created,
      width,
      height,
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
// Running or suspended FFmpeg processes whose command line carries the
// marker: the canvas size in the filtergraph ("s=<width>x180:"), unique per
// test through an unusual even width.
function ffmpegWith(marker: string) {
  const out = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ffmpeg.exe' -and $_.CommandLine -like ('*' + $env:MARKER + '*') } | ForEach-Object { $_.ProcessId }",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MARKER: marker },
    },
  ).stdout;
  return out.split(/s+/).filter(Boolean).map(Number);
}
async function noFfmpeg(marker: string) {
  for (let t = 0; t < 5000; t += 250) {
    if (!ffmpegWith(marker).length) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test("an export job renders through an owned worker and records its attempt", async () => {
  const { store, project } = await workspace();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submit(project.id, "first");
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  assert.equal(done.artifact, `exports/${job.id}/render-1.mp4`);
  assert.ok(
    await exists(
      await store.file(project.id, "exports", job.id, "render-1.mp4"),
    ),
  );
  const [attempt] = attempts(store, job.id);
  assert.equal(attempt.state, "succeeded");
  assert.ok(attempt.pid && attempt.pid > 0, "worker identity was recorded");
  assert.deepEqual(
    await readdir(await store.file(project.id, "exports", job.id)),
    ["render-1.mp4"],
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
      await store.file(project.id, "exports", raced.id, "render-1.mp4"),
    ),
    false,
  );
  const finished = await supervisor.submit(project.id, "complete-wins");
  assert.equal((await settled(supervisor, finished.id)).state, "COMPLETED");
  const late = supervisor.cancel(finished.id);
  assert.equal(late.state, "COMPLETED", "a completed job stays completed");
  assert.ok(
    await exists(
      await store.file(project.id, "exports", finished.id, "render-1.mp4"),
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
    await exists(
      await store.file(project.id, "exports", job.id, "render-1.mp4"),
    ),
    false,
  );
  // The newer run reconciles and completes the job.
  const next = new JobSupervisor(store);
  await next.start();
  assert.equal((await settled(next, job.id)).state, "COMPLETED");
  await next.close();
  store.close();
});

test("an export published just before a crash is removed when the restart reconciles it", async () => {
  const { store, project } = await workspace();
  let reached = false;
  let resume!: () => void;
  // The first run stops forever between publishing and committing success,
  // standing in for a service that died there.
  const first = new JobSupervisor(store, {
    fault: (point) => {
      if (point !== "after-publish") return;
      reached = true;
      return new Promise<void>((r) => (resume = r));
    },
  });
  await first.start();
  const job = await first.submit(project.id, "crash-after-publish");
  for (let t = 0; t < 30000 && !reached; t += 20)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(reached, "the attempt published its output");
  const target = await store.file(
    project.id,
    "exports",
    job.id,
    "render-1.mp4",
  );
  assert.ok(await exists(target), "the unregistered output is on disk");
  store.transaction((db) =>
    db
      .prepare("UPDATE jobs SET cancel_requested = 1 WHERE job_id = ?")
      .run(job.id),
  );
  const second = new JobSupervisor(store);
  await second.start();
  assert.equal(second.status(job.id).state, "CANCELLED");
  assert.equal(await exists(target), false, "reconciliation removed it");
  // The stale attempt wakes up fenced and changes nothing.
  resume();
  await first.close();
  await second.close();
  const after = second.status(job.id);
  assert.equal(after.state, "CANCELLED");
  assert.equal(after.artifact, null);
  assert.equal(await exists(target), false);
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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Polls until the condition holds or the time runs out; returns the outcome.
async function within(ms: number, condition: () => boolean | Promise<boolean>) {
  for (const started = performance.now(); performance.now() - started < ms;) {
    if (await condition()) return true;
    await pause(5);
  }
  return condition();
}

test(
  "a service killed mid-render leaves no FFmpeg, and the next start reconciles and finishes",
  { skip: process.platform !== "win32" },
  async () => {
    // Two minutes of 720p: the render takes 9-12 s on the development
    // machine, so its remaining work far outlasts the 1 s window below and an
    // orphaned FFmpeg would still be alive when it closes.
    const { root, store, project } = await workspace(3600, 1280, 720);
    store.close();
    const messages: any[] = [];
    let stderr = "";
    const child = fork(
      fileURLToPath(new URL("./fixtures/t5-service.ts", import.meta.url)),
      [root, project.id],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    child.on("message", (m) => messages.push(m));
    child.stderr!.on("data", (d) => (stderr += d));
    const running = () => child.exitCode === null && child.signalCode === null;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    // An early exit or a timeout fails the wait instead of hanging the test.
    async function next<T>(match: (m: any) => T | undefined, ms = 60000) {
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
    }
    const observer = new ProjectStore(root);
    let pid = 0;
    let ownerPid = 0;
    let supervisor: JobSupervisor | undefined;
    try {
      const jobId = await next<string>((m) => m?.jobId);
      ownerPid = await next<number>((m) => m?.ownerPid);
      await observer.initialize();
      // Kill only once FFmpeg is resumed and writing its output.
      const partial = path.join(
        root,
        "projects",
        project.id,
        "exports",
        jobId,
        "attempt-1",
        "worker",
        "render.partial.mp4",
      );
      await within(60000, async () => {
        if (!running()) throw new Error(`service exited early: ${stderr}`);
        pid =
          attempts(observer, jobId).find((a) => a.state === "running")?.pid ??
          0;
        const size = await stat(partial).then(
          (s) => s.size,
          () => 0,
        );
        return pid > 0 && size > 0;
      });
      assert.ok(pid && alive(pid), "FFmpeg is writing its output");
      assert.ok(running(), `service still running: ${stderr}`);
      child.kill("SIGKILL");
      await exited;
      assert.ok(
        await within(1000, () => !alive(pid) && !alive(ownerPid)),
        `FFmpeg ${alive(pid) ? "outlived" : "died with"} its service; procd ${alive(ownerPid) ? "outlived" : "died with"} it`,
      );
      supervisor = new JobSupervisor(observer);
      await supervisor.start();
      const done = await settled(supervisor, jobId);
      assert.equal(done.state, "COMPLETED", done.error ?? "");
      const history = attempts(observer, jobId);
      assert.equal(history[0].state, "failed");
      assert.match(history[0].error!, /restart/);
      assert.equal(history.at(-1)!.state, "succeeded");
      assert.ok(history.at(-1)!.generation > history[0].generation);
    } finally {
      // Stragglers from a failed run must not outlive the test.
      if (running()) child.kill("SIGKILL");
      for (const straggler of [pid, ownerPid])
        if (straggler && alive(straggler)) process.kill(straggler, "SIGKILL");
      await supervisor?.close();
      observer.close();
    }
  },
);

test(
  "killing the process owner mid-render ends FFmpeg; the job fails without an artifact and the next one completes",
  { skip: process.platform !== "win32" },
  async () => {
    const width = 2 * (200 + Math.floor(Math.random() * 400));
    const { store, project } = await workspace(18000, width);
    const marker = `s=${width}x180:`;
    const supervisor = new JobSupervisor(store);
    await supervisor.start();
    const job = await supervisor.submit(project.id, "owner-killed");
    let pid = 0;
    for (let t = 0; t < 30000 && !pid; t += 20) {
      pid =
        attempts(store, job.id).find((a) => a.state === "running")?.pid ?? 0;
      if (!pid) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pid && alive(pid), "FFmpeg is running");
    assert.deepEqual(ffmpegWith(marker), [pid], "the marker finds FFmpeg");
    const owner = workers().ownerPid;
    assert.ok(owner, "an owner is running");
    process.kill(owner, "SIGKILL");
    const done = await settled(supervisor, job.id);
    assert.equal(done.state, "FAILED");
    assert.equal(done.artifact, null);
    assert.equal(alive(pid), false, "FFmpeg ended with its owner");
    assert.ok(await noFfmpeg(marker), "no FFmpeg survives");
    assert.equal(
      await exists(
        await store.file(project.id, "exports", job.id, "render-1.mp4"),
      ),
      false,
    );
    // A new owner starts for the next job.
    const next = await workspace();
    const after = new JobSupervisor(next.store);
    await after.start();
    const ok = await after.submit(next.project.id, "after-owner-death");
    assert.equal((await settled(after, ok.id)).state, "COMPLETED");
    await after.close();
    await supervisor.close();
    next.store.close();
    store.close();
  },
);

test(
  "an owner that dies between creating FFmpeg and resuming it leaves no suspended FFmpeg",
  { skip: process.platform !== "win32" },
  async () => {
    const width = 2 * (200 + Math.floor(Math.random() * 400));
    const { store, project } = await workspace(30, width);
    const marker = `s=${width}x180:`;
    // The fault applies to the next owner started.
    const running = workers().ownerPid;
    if (running) {
      process.kill(running, "SIGKILL");
      for (let t = 0; t < 5000 && workers().ownerPid; t += 50)
        await new Promise((r) => setTimeout(r, 50));
    }
    process.env.YAMAKAN_PROCD_FAULT = "after-create";
    const supervisor = new JobSupervisor(store);
    try {
      await supervisor.start();
      const job = await supervisor.submit(project.id, "launch-seam");
      const done = await settled(supervisor, job.id);
      assert.equal(done.state, "FAILED");
      assert.equal(done.artifact, null);
      assert.ok(await noFfmpeg(marker), "no suspended FFmpeg survives");
    } finally {
      delete process.env.YAMAKAN_PROCD_FAULT;
      await supervisor.close();
      store.close();
    }
  },
);

test("a job interrupted too many times is set aside instead of retried forever", async () => {
  const { store, project } = await workspace();
  const jobId = crypto.randomUUID();
  store.transaction((db) => {
    db.prepare(
      "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'export', ?, ?, 'crashy', ?, 'queued')",
    ).run(
      jobId,
      project.id,
      project.revision,
      JSON.stringify({ format: "export/1" }),
    );
    for (let n = 1; n <= 3; n++)
      db.prepare(
        "INSERT INTO attempts(job_id, attempt_no, generation, state, error) VALUES (?, ?, 1, 'failed', 'Interrupted by a service restart.')",
      ).run(jobId, n);
  });
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const done = await settled(supervisor, jobId);
  assert.equal(done.state, "FAILED");
  assert.equal(done.detail, "reconciliationRequired");
  assert.equal(attempts(store, jobId).length, 3, "no fourth attempt ran");
  // Other work still runs.
  const next = await supervisor.submit(project.id, "after-crashy");
  assert.equal((await settled(supervisor, next.id)).state, "COMPLETED");
  await supervisor.close();
  store.close();
});

test("a supervisor from an older generation stops claiming and refuses new work; start() twice keeps its generation", async () => {
  const { store, project } = await workspace(3000);
  const older = new JobSupervisor(store);
  await older.start();
  const generation = () =>
    (
      store.read((db) =>
        db.prepare("SELECT generation FROM supervisor WHERE id = 1").get(),
      ) as { generation: number }
    ).generation;
  const before = generation();
  await older.start();
  assert.equal(generation(), before, "a second start is a no-op");
  // The older run is rendering a long job with another queued behind it.
  const long = await older.submit(project.id, "long");
  const queued = await older.submit(project.id, "queued-behind");
  for (
    let t = 0;
    t < 30000 && attempts(store, long.id)[0]?.state !== "running";
    t += 20
  )
    await new Promise((r) => setTimeout(r, 20));
  // A newer run takes over: it fences the running attempt and owns the queue.
  const newer = new JobSupervisor(store);
  await newer.start();
  await assert.rejects(
    older.submit(project.id, "too-late"),
    (e: unknown) => e instanceof CommandError && e.code === "UNAVAILABLE",
  );
  assert.equal((await settled(newer, long.id)).state, "COMPLETED");
  assert.equal((await settled(newer, queued.id)).state, "COMPLETED");
  await older.close();
  // Nothing the older run claimed after the takeover: every attempt of the
  // queued job belongs to the newer generation.
  assert.deepEqual(
    attempts(store, queued.id).map((a) => a.generation),
    [generation()],
  );
  await newer.close();
  store.close();
});

test("a completed export names its render plan and keeps a probe receipt", async () => {
  const { store, project } = await workspace();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submit(project.id, "receipt");
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  assert.match(done.planHash ?? "", /^[a-f0-9]{64}$/);
  const { receipt } = store.read((db) =>
    db
      .prepare(
        "SELECT receipt FROM attempts WHERE job_id = ? AND state = 'succeeded'",
      )
      .get(job.id),
  ) as { receipt: string };
  assert.deepEqual(JSON.parse(receipt), {
    planHash: done.planHash,
    width: 320,
    height: 180,
    durationFrames: 30,
    hasAudio: false,
    libassApi: JSON.parse(receipt).libassApi,
  });
  assert.ok(JSON.parse(receipt).libassApi >= 0x01700000, "titles drawn");
  await supervisor.close();
  store.close();
});

test("running out of space while publishing an export publishes nothing", async () => {
  const { store, project } = await workspace();
  const supervisor = new JobSupervisor(store, {
    fault: (point) => {
      if (point === "before-publish")
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
    },
  });
  await supervisor.start();
  const job = await supervisor.submit(project.id, "enospc");
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "FAILED");
  assert.equal(done.artifact, null);
  assert.equal(done.planHash, null);
  assert.equal(
    await exists(await store.file(project.id, "exports", job.id)),
    false,
    "no output, staging or job folder remains",
  );
  await supervisor.close();
  store.close();
});
