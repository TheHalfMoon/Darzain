// Durable jobs (plan T5, contract "Durable jobs and owned processes").
// Jobs hold intent (project, frozen revision, idempotency key, payload);
// attempts hold execution identity (generation, worker PID, outcome). Every
// transition is a compare-and-swap inside one SQLite transaction, attempts
// are fenced by the supervisor generation, and a restart reconciles attempts
// from an earlier generation: their Job Object workers died with that service,
// so they are marked failed and their jobs re-queued (local work only, never
// a paid resubmission). Partial outputs are never registered.
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "./store.ts";
import { AssetSchema } from "./project.ts";
import type { Asset } from "./project.ts";
import { probe } from "./media.ts";
import { mediaTools, workers } from "./process/workers.ts";
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
const DerivativePayload = z
  .object({
    format: z.literal("cfr/1"),
    asset: AssetSchema,
    frameRate: z
      .object({
        num: z.number().int().positive().max(1_000_000),
        den: z.number().int().positive().max(1_000_000),
      })
      .strict(),
  })
  .strict();

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

  // The worker's identity is durable before it may run.
  #markRunning(jobId: string, attempt: number, pid: number) {
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
    });
  }
  #markValidating(jobId: string, attempt: number) {
    this.#fenced(jobId, attempt, (db) => {
      db.prepare(
        "UPDATE jobs SET state = 'validating' WHERE job_id = ? AND state = 'running'",
      ).run(jobId);
      db.prepare(
        "UPDATE attempts SET state = 'validating' WHERE job_id = ? AND attempt_no = ?",
      ).run(jobId, attempt);
    });
  }
  // Success inside a caller's transaction: fenced, and decided by the
  // database, so a cancellation that won stays won (the caller's whole
  // transaction then rolls back).
  #succeedIn(
    db: DatabaseSync,
    jobId: string,
    attempt: number,
    artifact: string,
  ) {
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
    const moved = db
      .prepare(
        "UPDATE jobs SET state = 'succeeded', artifact = ?, progress = 1, error = NULL WHERE job_id = ? AND state = 'validating' AND cancel_requested = 0",
      )
      .run(artifact, jobId);
    if (moved.changes !== 1) throw new Error("Cancelled.");
    db.prepare(
      "UPDATE attempts SET state = 'succeeded' WHERE job_id = ? AND attempt_no = ?",
    ).run(jobId, attempt);
  }

  async #execute(row: Row, attempt: number) {
    const jobId = row.job_id;
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    const output = { published: null as string | null };
    try {
      await this.#options.fault?.("after-claim", jobId);
      const payload = safeJson(row.payload);
      const derivative = DerivativePayload.safeParse(payload);
      if (row.kind === "export" && ExportPayload.safeParse(payload).success)
        await this.#runExport(row, attempt, controller.signal, output);
      else if (row.kind === "cfr-derivative" && derivative.success)
        await this.#runDerivative(
          row,
          attempt,
          derivative.data,
          controller.signal,
        );
      // A bad payload never blocks other jobs: it is quarantined as failed.
      else
        this.#finish(
          jobId,
          attempt,
          "failed",
          "Job payload is invalid and was quarantined.",
        );
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
      if (output.published) await unlink(output.published).catch(() => {});
      this.#controllers.delete(jobId);
      this.#progress.delete(jobId);
      await this.#cleanup(row.project_id, jobId, attempt);
    }
  }

  async #runExport(
    row: Row,
    attempt: number,
    signal: AbortSignal,
    output: { published: string | null },
  ) {
    const jobId = row.job_id;
    const project = await this.store.loadRevision(
      row.project_id,
      row.frozen_revision,
    );
    const partial = await renderProject(
      this.store,
      project,
      ["exports", jobId, `attempt-${attempt}`],
      signal,
      (value) => this.#progress.set(jobId, value),
      (pid) => this.#markRunning(jobId, attempt, pid),
    );
    this.#markValidating(jobId, attempt);
    await this.#options.fault?.("before-publish", jobId);
    const target = await this.store.file(
      row.project_id,
      "exports",
      jobId,
      "render.mp4",
    );
    await rename(partial, target);
    output.published = target;
    await this.#options.fault?.("after-publish", jobId);
    await this.#options.fault?.("before-succeed", jobId);
    this.store.transaction((db) =>
      this.#succeedIn(db, jobId, attempt, `exports/${jobId}/render.mp4`),
    );
    output.published = null;
  }

  // Converts a variable-frame-rate source into a constant-rate mezzanine and
  // attaches it as the asset's selected version. The original object stays
  // retained; the derivative version records its lineage. Attachment and the
  // job's success commit in one transaction.
  async #runDerivative(
    row: Row,
    attempt: number,
    payload: z.output<typeof DerivativePayload>,
    signal: AbortSignal,
  ) {
    const jobId = row.job_id;
    const asset = payload.asset;
    const source = await this.store.objectFile(row.project_id, asset);
    const dir = await this.store.file(
      row.project_id,
      "exports",
      jobId,
      `attempt-${attempt}`,
    );
    await mkdir(dir, { recursive: true });
    const seconds = Math.max(1, asset.durationFrames / 30);
    let progress = "";
    const result = await workers().run({
      executable: mediaTools().ffmpeg,
      args: [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-fps_mode",
        "cfr",
        "-r",
        `${payload.frameRate.num}/${payload.frameRate.den}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "derivative.mp4",
      ],
      cwd: dir,
      memoryBytes: RESOURCE_POLICY.enforced.renderMemoryBytes,
      signal,
      stderrLimit: 8000,
      onCreated: (pid) => this.#markRunning(jobId, attempt, pid),
      onStdout: (chunk) => {
        progress += chunk.toString("utf8");
        const lines = progress.split("\n");
        progress = lines.pop() || "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match)
            this.#progress.set(
              jobId,
              Math.min(0.99, Number(match[1]) / 1e6 / seconds),
            );
        }
      },
    });
    if (signal.aborted) throw new Error("Cancelled.");
    if (result.code !== 0)
      throw new Error(
        `FFmpeg failed to convert the source (exit ${result.code}).`,
        { cause: result.stderr },
      );
    const file = path.join(dir, "derivative.mp4");
    const probed = await probe(file);
    if (
      !probed.hasVideo ||
      probed.variableFrameRate ||
      probed.width !== asset.width ||
      probed.height !== asset.height ||
      // Filling a VFR stream to constant rate can extend it to its nominal end.
      Math.abs(probed.durationFrames - asset.durationFrames) >
        Math.max(2, Math.ceil(asset.durationFrames * 0.05))
    )
      throw new Error("Converted output failed verification.");
    this.#markValidating(jobId, attempt);
    const stored = await this.store.importObject(
      row.project_id,
      createReadStream(file) as AsyncIterable<Uint8Array>,
    );
    const derived = AssetSchema.parse({
      ...asset,
      extension: "mp4",
      hash: stored.sha256,
      bytes: stored.byteLength,
      durationFrames: probed.durationFrames,
    });
    await this.#options.fault?.("before-succeed", jobId);
    await this.store.attachAsset(row.project_id, derived, (db) => {
      ProjectStore.registerDerivative(
        db,
        row.project_id,
        { hash: derived.hash, bytes: derived.bytes },
        {
          format: probed.format,
          width: probed.width,
          height: probed.height,
          timebase: probed.timebase,
          frameRate: probed.frameRate,
          variableFrameRate: false,
          derivedFrom: { versionId: asset.id, digest: asset.hash },
          conversion: "cfr/1",
        },
      );
      this.#succeedIn(db, jobId, attempt, `asset:${asset.id}`);
    });
  }

  // Queues the constant-rate conversion of a staged variable-frame-rate
  // source. The asset joins the project only when the conversion succeeds.
  async submitDerivative(
    projectId: string,
    staged: {
      asset: Asset;
      probe: { frameRate: { num: number; den: number } | null };
    },
  ) {
    if (this.#closing) throw new Error("Render queue is closing.");
    if (!this.#generation) await this.start();
    const project = await this.store.load(projectId);
    const payload = DerivativePayload.parse({
      format: "cfr/1",
      asset: staged.asset,
      frameRate: staged.probe.frameRate ?? { num: 30, den: 1 },
    });
    const key = `cfr-${staged.asset.hash}`;
    const row = this.store.transaction((db) => {
      const existing = db
        .prepare(
          "SELECT * FROM jobs WHERE project_id = ? AND kind = 'cfr-derivative' AND idempotency_key = ?",
        )
        .get(projectId, key) as Row | undefined;
      if (
        existing &&
        existing.state !== "failed" &&
        existing.state !== "cancelled"
      )
        return existing;
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
        "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'cfr-derivative', ?, ?, ?, ?, 'queued')",
      ).run(
        jobId,
        projectId,
        project.revision,
        existing ? `${key}-${jobId.slice(0, 8)}` : key,
        JSON.stringify(payload),
      );
      return this.#row(db, jobId)!;
    });
    this.#pump();
    return this.#view(row);
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
