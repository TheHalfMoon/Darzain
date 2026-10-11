// Durable jobs (plan T5, contract "Durable jobs and owned processes").
// Jobs hold intent (project, frozen revision, idempotency key, payload);
// attempts hold execution identity (generation, worker PID, outcome). Every
// transition is a compare-and-swap inside one SQLite transaction, attempts
// are fenced by the supervisor generation, and a restart reconciles attempts
// from an earlier generation: their Job Object workers died with that service,
// so they are marked failed and their jobs re-queued (local work only, never
// a paid resubmission). Partial outputs are never registered.
import { rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectStore } from "./store.ts";
import { renderProject } from "./render.ts";
import type { RenderJob } from "./render.ts";
import { CommandError, toCommandError } from "./command/errors.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";

export type JobState =
  | "queued"
  | "preparing"
  | "running"
  | "validating"
  | "succeeded"
  | "cancelRequested"
  | "cancelled"
  | "failed"
  | "reconciliationRequired";
const TERMINAL = ["succeeded", "cancelled", "failed", "reconciliationRequired"];
const terminalSql = TERMINAL.map((s) => `'${s}'`).join(", ");

type Row = {
  job_id: string;
  kind: string;
  project_id: string;
  frozen_revision: number;
  idempotency_key: string;
  payload: string;
  state: JobState;
  cancel_requested: number;
  progress: number;
  error: string | null;
  artifact: string | null;
};

// The only payload this build executes; anything else is quarantined.
const ExportPayload = z.object({ format: z.literal("export/1") }).strict();

export type JobFault =
  "after-claim" | "before-publish" | "after-publish" | "before-succeed";
export type SupervisorOptions = {
  fault?: (point: JobFault, jobId: string) => void | Promise<void>;
};

// Job states as the editor and agents see them (RenderJob), plus the exact state.
const publicState = (s: JobState): RenderJob["state"] => {
  if (s === "succeeded") return "COMPLETED";
  if (s === "cancelled") return "CANCELLED";
  if (s === "failed" || s === "reconciliationRequired") return "FAILED";
  if (s === "queued") return "QUEUED";
  return "RUNNING";
};

export class JobSupervisor {
  readonly store: ProjectStore;
  readonly #options: SupervisorOptions;
  #generation = 0;
  #loop: Promise<void> | null = null;
  #closing = false;
  #controllers = new Map<string, AbortController>();
  #progress = new Map<string, number>();

  constructor(store: ProjectStore, options: SupervisorOptions = {}) {
    this.store = store;
    this.#options = options;
  }

  // Takes a new generation, fences and reconciles earlier attempts, and starts
  // running queued work.
  async start() {
    const interrupted = this.store.transaction((db) => {
      db.prepare(
        "UPDATE supervisor SET generation = generation + 1 WHERE id = 1",
      ).run();
      this.#generation = (
        db.prepare("SELECT generation FROM supervisor WHERE id = 1").get() as {
          generation: number;
        }
      ).generation;
      const stale = db
        .prepare(
          "SELECT a.job_id, a.attempt_no, j.project_id, j.cancel_requested FROM attempts a JOIN jobs j ON j.job_id = a.job_id WHERE a.state IN ('preparing', 'running', 'validating') AND a.generation < ?",
        )
        .all(this.#generation) as {
        job_id: string;
        attempt_no: number;
        project_id: string;
        cancel_requested: number;
      }[];
      for (const a of stale) {
        db.prepare(
          "UPDATE attempts SET state = 'failed', error = 'Interrupted by a service restart.' WHERE job_id = ? AND attempt_no = ?",
        ).run(a.job_id, a.attempt_no);
        db.prepare(
          "UPDATE jobs SET state = ?, progress = 0 WHERE job_id = ?",
        ).run(a.cancel_requested ? "cancelled" : "queued", a.job_id);
      }
      return stale;
    });
    // Unregistered partial outputs of interrupted attempts are removed.
    for (const a of interrupted)
      await this.#cleanup(a.project_id, a.job_id, a.attempt_no);
    this.#pump();
  }

  #view(row: Row): RenderJob & { detail: JobState } {
    return {
      id: row.job_id,
      projectId: row.project_id,
      revision: row.frozen_revision,
      state: publicState(row.state),
      detail: row.state,
      progress: this.#progress.get(row.job_id) ?? row.progress,
      error: row.error,
      artifact: row.artifact,
    };
  }
  #row(db: DatabaseSync, jobId: string) {
    return db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      Row | undefined;
  }

  async submit(projectId: string, key: string) {
    if (this.#closing) throw new Error("Render queue is closing.");
    if (!this.#generation) await this.start();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key))
      throw new Error("Invalid idempotency key.");
    const project = await this.store.load(projectId);
    if (this.#closing) throw new Error("Render queue is closing.");
    const row = this.store.transaction((db) => {
      const existing = db
        .prepare(
          "SELECT * FROM jobs WHERE project_id = ? AND kind = 'export' AND frozen_revision = ? AND idempotency_key = ?",
        )
        .get(projectId, project.revision, key) as Row | undefined;
      if (existing) return existing;
      // Admission counts active work only; finished history never blocks it.
      const active = (
        db
          .prepare(
            `SELECT count(*) AS n FROM jobs WHERE state NOT IN (${terminalSql})`,
          )
          .get() as { n: number }
      ).n;
      if (active >= RESOURCE_POLICY.enforced.activeJobs)
        throw new CommandError("LIMIT_EXCEEDED", "Too many active jobs.");
      const jobId = randomUUID();
      db.prepare(
        "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'export', ?, ?, ?, ?, 'queued')",
      ).run(
        jobId,
        projectId,
        project.revision,
        key,
        JSON.stringify({ format: "export/1" }),
      );
      return this.#row(db, jobId)!;
    });
    this.#pump();
    return this.#view(row);
  }

  status(jobId: string) {
    const row = this.store.read((db) => this.#row(db, jobId));
    if (!row) throw new Error("Job not found.");
    return this.#view(row);
  }

  list(limit = 100) {
    return (
      this.store.read((db) =>
        db
          .prepare("SELECT * FROM jobs ORDER BY rowid DESC LIMIT ?")
          .all(Math.min(Math.max(1, limit), 500)),
      ) as Row[]
    ).map((r) => this.#view(r));
  }

  // Queued jobs cancel at once. Running ones are marked, their worker's job is
  // terminated, and the terminal state follows once the worker has exited.
  cancel(jobId: string) {
    const row = this.store.transaction((db) => {
      const row = this.#row(db, jobId);
      if (!row) throw new Error("Job not found.");
      if (TERMINAL.includes(row.state)) return row;
      if (row.state === "queued")
        db.prepare(
          "UPDATE jobs SET state = 'cancelled' WHERE job_id = ? AND state = 'queued'",
        ).run(jobId);
      else
        db.prepare(
          "UPDATE jobs SET state = 'cancelRequested', cancel_requested = 1 WHERE job_id = ?",
        ).run(jobId);
      return this.#row(db, jobId)!;
    });
    this.#controllers.get(jobId)?.abort();
    return this.#view(row);
  }

  #pump() {
    if (this.#loop || this.#closing || !this.#generation) return;
    this.#loop = (async () => {
      // One active render worker at a time (policy activeRenderWorkers).
      for (;;) {
        if (this.#closing) break;
        const claimed = this.#claim();
        if (!claimed) break;
        await this.#execute(claimed.row, claimed.attempt);
      }
    })().finally(() => {
      this.#loop = null;
      if (!this.#closing && this.#hasQueued()) this.#pump();
    });
  }
  #hasQueued() {
    return Boolean(
      this.store.read((db) =>
        db.prepare("SELECT 1 FROM jobs WHERE state = 'queued' LIMIT 1").get(),
      ),
    );
  }

  #claim() {
    return this.store.transaction((db) => {
      const row = db
        .prepare(
          "SELECT * FROM jobs WHERE state = 'queued' ORDER BY rowid LIMIT 1",
        )
        .get() as Row | undefined;
      if (!row) return null;
      const attempt =
        (
          db
            .prepare(
              "SELECT coalesce(max(attempt_no), 0) AS n FROM attempts WHERE job_id = ?",
            )
            .get(row.job_id) as { n: number }
        ).n + 1;
      const moved = db
        .prepare(
          "UPDATE jobs SET state = 'preparing', error = NULL WHERE job_id = ? AND state = 'queued'",
        )
        .run(row.job_id);
      if (moved.changes !== 1) return null;
      db.prepare(
        "INSERT INTO attempts(job_id, attempt_no, generation, state) VALUES (?, ?, ?, 'preparing')",
      ).run(row.job_id, attempt, this.#generation);
      return { row: { ...row, state: "preparing" as JobState }, attempt };
    });
  }

  // Fenced transition: only this generation's attempt may move the job.
  #fenced(jobId: string, attempt: number, fn: (db: DatabaseSync) => void) {
    this.store.transaction((db) => {
      const current = (
        db.prepare("SELECT generation FROM supervisor WHERE id = 1").get() as {
          generation: number;
        }
      ).generation;
      const own = db
        .prepare(
          "SELECT generation FROM attempts WHERE job_id = ? AND attempt_no = ?",
        )
        .get(jobId, attempt) as { generation: number } | undefined;
      if (current !== this.#generation || own?.generation !== this.#generation)
        throw new CommandError(
          "RECOVERY_REQUIRED",
          "This attempt belongs to an earlier service run.",
        );
      fn(db);
    });
  }

  #finish(
    jobId: string,
    attempt: number,
    state: "cancelled" | "failed" | "queued",
    error: string | null,
  ) {
    this.#fenced(jobId, attempt, (db) => {
      db.prepare(
        "UPDATE attempts SET state = ?, error = ? WHERE job_id = ? AND attempt_no = ?",
      ).run(state === "queued" ? "failed" : state, error, jobId, attempt);
      db.prepare(
        "UPDATE jobs SET state = ?, error = ?, progress = ? WHERE job_id = ?",
      ).run(
        state,
        state === "queued" ? null : error,
        state === "queued" ? 0 : (this.#progress.get(jobId) ?? 0),
        jobId,
      );
    });
  }

  async #cleanup(projectId: string, jobId: string, attempt: number) {
    await rm(
      await this.store.file(projectId, "exports", jobId, `attempt-${attempt}`),
      { recursive: true, force: true, maxRetries: 3 },
    ).catch(() => {});
  }

  async #execute(row: Row, attempt: number) {
    const jobId = row.job_id;
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    let published: string | null = null;
    try {
      await this.#options.fault?.("after-claim", jobId);
      if (!ExportPayload.safeParse(safeJson(row.payload)).success) {
        // A bad payload never blocks other jobs: it is quarantined as failed.
        this.#finish(
          jobId,
          attempt,
          "failed",
          "Job payload is invalid and was quarantined.",
        );
        return;
      }
      const project = await this.store.loadRevision(
        row.project_id,
        row.frozen_revision,
      );
      const partial = await renderProject(
        this.store,
        project,
        ["exports", jobId, `attempt-${attempt}`],
        controller.signal,
        (value) => this.#progress.set(jobId, value),
        // The worker's identity is durable before it may run.
        (pid) =>
          this.#fenced(jobId, attempt, (db) => {
            const moved = db
              .prepare(
                "UPDATE jobs SET state = 'running' WHERE job_id = ? AND state = 'preparing' AND cancel_requested = 0",
              )
              .run(jobId);
            if (moved.changes !== 1) throw new Error("Cancelled.");
            db.prepare(
              "UPDATE attempts SET state = 'running', pid = ? WHERE job_id = ? AND attempt_no = ?",
            ).run(pid, jobId, attempt);
          }),
      );
      this.#fenced(jobId, attempt, (db) => {
        db.prepare(
          "UPDATE jobs SET state = 'validating' WHERE job_id = ? AND state = 'running'",
        ).run(jobId);
        db.prepare(
          "UPDATE attempts SET state = 'validating' WHERE job_id = ? AND attempt_no = ?",
        ).run(jobId, attempt);
      });
      await this.#options.fault?.("before-publish", jobId);
      const target = await this.store.file(
        row.project_id,
        "exports",
        jobId,
        "render.mp4",
      );
      await rename(partial, target);
      published = target;
      await this.#options.fault?.("after-publish", jobId);
      await this.#options.fault?.("before-succeed", jobId);
      // Success is decided by the database: a cancellation that won stays won.
      let succeeded = false;
      this.#fenced(jobId, attempt, (db) => {
        const moved = db
          .prepare(
            "UPDATE jobs SET state = 'succeeded', artifact = ?, progress = 1, error = NULL WHERE job_id = ? AND state = 'validating' AND cancel_requested = 0",
          )
          .run(`exports/${jobId}/render.mp4`, jobId);
        succeeded = moved.changes === 1;
        db.prepare(
          "UPDATE attempts SET state = ? WHERE job_id = ? AND attempt_no = ?",
        ).run(succeeded ? "succeeded" : "cancelled", jobId, attempt);
        if (!succeeded)
          db.prepare(
            "UPDATE jobs SET state = 'cancelled' WHERE job_id = ? AND state NOT IN ('succeeded')",
          ).run(jobId);
      });
      if (succeeded) published = null;
    } catch (e) {
      const cancelled = this.store.read(
        (db) => this.#row(db, jobId)?.cancel_requested === 1,
      );
      try {
        if (cancelled) this.#finish(jobId, attempt, "cancelled", null);
        else if (this.#closing)
          // Graceful shutdown: the next start runs this job again.
          this.#finish(jobId, attempt, "queued", "Service stopped.");
        else
          this.#finish(
            jobId,
            attempt,
            "failed",
            toCommandError(e).message.replaceAll(
              this.store.root,
              "[workspace]",
            ),
          );
      } catch {
        // Fenced out: a newer service run owns this job now.
      }
    } finally {
      // An output that was not registered as the job's artifact is removed.
      if (published) await unlink(published).catch(() => {});
      this.#controllers.delete(jobId);
      this.#progress.delete(jobId);
      await this.#cleanup(row.project_id, jobId, attempt);
    }
  }

  // Stops claiming work, terminates running workers and waits for the loop.
  async close() {
    this.#closing = true;
    for (const controller of this.#controllers.values()) controller.abort();
    await this.#loop;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
