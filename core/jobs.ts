// Durable jobs (plan T5, contract "Durable jobs and owned processes").
// Jobs hold intent (project, frozen revision, idempotency key, payload);
// attempts hold execution identity (generation, worker PID, outcome). Every
// transition is a compare-and-swap inside one SQLite transaction, attempts
// are fenced by the supervisor generation, and a restart reconciles attempts
// from an earlier generation: their Job Object workers died with that service,
// so they are marked failed and their jobs re-queued (local work only, never
// a paid resubmission). Partial outputs are never registered.
import {
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "./store.ts";
import { AssetSchema } from "./project.ts";
import type { Asset } from "./project.ts";
import { MEDIA_FORMATS, probe } from "./media.ts";
import { mediaTools, workers } from "./process/workers.ts";
import { keepMainStream, renderRevision } from "./render.ts";
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
// Attempts interrupted by a crash (not a graceful stop) are retried locally
// at most this many times; the job is then set aside for reconciliation.
const MAX_INTERRUPTIONS = 3;
const INTERRUPTED = "Interrupted by a service restart.";

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
  plan_hash?: string | null;
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
  #setAside: string[] = [];
  // Set once a newer service run has taken the queue; this one never claims again.
  #superseded = false;

  constructor(store: ProjectStore, options: SupervisorOptions = {}) {
    this.store = store;
    this.#options = options;
  }

  // Takes a new generation, fences and reconciles earlier attempts, and starts
  // running queued work.
  async start() {
    // A second start would fence out this supervisor's own live attempts.
    if (this.#generation) return;
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
          "SELECT a.job_id, a.attempt_no, j.kind, j.project_id, j.cancel_requested FROM attempts a JOIN jobs j ON j.job_id = a.job_id WHERE a.state IN ('preparing', 'running', 'validating') AND a.generation < ?",
        )
        .all(this.#generation) as {
        job_id: string;
        attempt_no: number;
        kind: string;
        project_id: string;
        cancel_requested: number;
      }[];
      for (const a of stale) {
        db.prepare(
          "UPDATE attempts SET state = 'failed', error = ? WHERE job_id = ? AND attempt_no = ?",
        ).run(INTERRUPTED, a.job_id, a.attempt_no);
        db.prepare(
          "UPDATE jobs SET state = ?, progress = 0 WHERE job_id = ?",
        ).run(a.cancel_requested ? "cancelled" : "queued", a.job_id);
      }
      return stale;
    });
    // Unregistered outputs of interrupted attempts are removed, including an
    // export published just before its success could commit.
    for (const a of interrupted) {
      if (a.kind === "export")
        await unlink(
          await this.store.file(
            a.project_id,
            "exports",
            a.job_id,
            `render-${a.attempt_no}.mp4`,
          ),
        ).catch(() => {});
      await this.#cleanup(a.project_id, a.job_id, a.attempt_no);
      await this.#release(a.job_id);
    }
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
      planHash: row.plan_hash ?? null,
    };
  }
  #row(db: DatabaseSync, jobId: string) {
    return db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      Row | undefined;
  }

  async submit(projectId: string, key: string) {
    if (this.#closing) throw new Error("Render queue is closing.");
    this.#current();
    if (!this.#generation) await this.start();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key))
      throw new Error("Invalid idempotency key.");
    const project = await this.store.load(projectId);
    if (this.#closing) throw new Error("Render queue is closing.");
    const row = this.store.transaction((db) => {
      this.#currentIn(db);
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
    if (row.state === "cancelled") void this.#release(jobId);
    return this.#view(row);
  }

  #pump() {
    if (this.#loop || this.#closing || this.#superseded || !this.#generation)
      return;
    this.#loop = (async () => {
      // One active render worker at a time (policy activeRenderWorkers).
      for (;;) {
        if (this.#closing) break;
        const claimed = this.#claim();
        for (const jobId of this.#setAside.splice(0))
          await this.#release(jobId);
        if (!claimed) break;
        await this.#execute(claimed.row, claimed.attempt);
      }
    })()
      // A store error (BUSY, for example) ends this pass; it is retried after
      // a pause rather than in a tight loop.
      .then(
        () => false,
        () => true,
      )
      .then((failed) => {
        this.#loop = null;
        if (failed) {
          if (!this.#closing) setTimeout(() => this.#pump(), 1000).unref();
          return;
        }
        let more = false;
        try {
          more = !this.#closing && this.#hasQueued();
        } catch {}
        if (more) this.#pump();
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
      const current = (
        db.prepare("SELECT generation FROM supervisor WHERE id = 1").get() as {
          generation: number;
        }
      ).generation;
      // A newer service run owns the queue; this one stops claiming.
      if (current !== this.#generation) {
        this.#superseded = true;
        return null;
      }
      for (;;) {
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
        const interruptions = (
          db
            .prepare(
              "SELECT count(*) AS n FROM attempts WHERE job_id = ? AND error = ?",
            )
            .get(row.job_id, INTERRUPTED) as { n: number }
        ).n;
        if (interruptions >= MAX_INTERRUPTIONS) {
          db.prepare(
            "UPDATE jobs SET state = 'reconciliationRequired', error = 'The job was interrupted too many times.' WHERE job_id = ?",
          ).run(row.job_id);
          this.#setAside.push(row.job_id);
          continue;
        }
        return this.#claimIn(db, row, attempt);
      }
    });
  }

  #claimIn(db: DatabaseSync, row: Row, attempt: number) {
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
      const moved = db
        .prepare(
          "UPDATE jobs SET state = 'validating' WHERE job_id = ? AND state = 'running' AND cancel_requested = 0",
        )
        .run(jobId);
      if (moved.changes !== 1) throw new Error("Cancelled.");
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
    receipt?: { planHash: string },
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
        "UPDATE jobs SET state = 'succeeded', artifact = ?, plan_hash = ?, progress = 1, error = NULL WHERE job_id = ? AND state = 'validating' AND cancel_requested = 0",
      )
      .run(artifact, receipt?.planHash ?? null, jobId);
    if (moved.changes !== 1) throw new Error("Cancelled.");
    db.prepare(
      "UPDATE attempts SET state = 'succeeded', receipt = ? WHERE job_id = ? AND attempt_no = ?",
    ).run(receipt ? JSON.stringify(receipt) : null, jobId, attempt);
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
      // An output that was not registered as the job's artifact, the
      // attempt's staging and an emptied job folder are removed before the
      // terminal state becomes visible.
      if (output.published) {
        await unlink(output.published).catch(() => {});
        output.published = null;
      }
      await this.#cleanup(row.project_id, jobId, attempt);
      await this.#removeEmptyJobFolder(row.project_id, jobId);
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
      this.#controllers.delete(jobId);
      this.#progress.delete(jobId);
      await this.#cleanup(row.project_id, jobId, attempt);
      // Removed only when empty: an export's artifact keeps its folder.
      await this.#removeEmptyJobFolder(row.project_id, jobId);
      await this.#release(jobId);
    }
  }

  // A conversion that ended without success releases the staged original it
  // was holding; it never joined the project, so nothing else refers to it.
  async #release(jobId: string) {
    try {
      const row = this.store.read((db) => this.#row(db, jobId));
      if (
        row?.kind !== "cfr-derivative" ||
        !["failed", "cancelled"].includes(row.state)
      )
        return;
      const payload = DerivativePayload.safeParse(safeJson(row.payload));
      if (payload.success)
        await this.store.discardStagedVersion(
          row.project_id,
          payload.data.asset.id,
        );
    } catch {
      // Left for the T9 garbage collector.
    }
  }

  async #runExport(
    row: Row,
    attempt: number,
    signal: AbortSignal,
    output: { published: string | null },
  ) {
    const jobId = row.job_id;
    // The plan is compiled from the frozen revision's stored snapshot; the
    // render draws only what the plan says.
    const { output: partial, receipt } = await renderRevision(
      this.store,
      row.project_id,
      row.frozen_revision,
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
      `render-${attempt}.mp4`,
    );
    await rename(partial, target);
    output.published = target;
    await this.#options.fault?.("after-publish", jobId);
    await this.#cleanup(row.project_id, jobId, attempt);
    await this.#options.fault?.("before-succeed", jobId);
    this.store.transaction((db) =>
      this.#succeedIn(
        db,
        jobId,
        attempt,
        `exports/${jobId}/render-${attempt}.mp4`,
        receipt,
      ),
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
    // The worker writes only its own subfolder; the service keeps its copy
    // in the attempt folder, which the worker could never write.
    const work = path.join(dir, "worker");
    await mkdir(work, { recursive: true });
    const seconds = Math.max(1, asset.durationFrames / 30);
    let progress = "";
    if (signal.aborted) throw new Error("Cancelled.");
    // The conversion and its published copy share the space above the
    // import reserve; FFmpeg stops writing at that size (-fs).
    const space = await statfs(dir);
    const outputCap = Math.min(
      RESOURCE_POLICY.enforced.assetImportBytes,
      Math.floor(
        (Number(space.bavail) * Number(space.bsize) -
          RESOURCE_POLICY.enforced.diskReserveBytes) /
          2,
      ),
    );
    if (outputCap < 16 * 1024 * 1024)
      throw new CommandError(
        "LIMIT_EXCEEDED",
        "Insufficient free disk space for the conversion.",
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RESOURCE_POLICY.enforced.conversionWallSeconds * 1000);
    const result = await workers()
      .run({
        executable: mediaTools().ffmpeg,
        args: [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-threads",
          String(RESOURCE_POLICY.enforced.renderThreads),
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          MEDIA_FORMATS,
          "-i",
          source,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          // libx264 4:2:0 needs even dimensions; FFmpeg has already applied
          // any display rotation, so these are the upright dimensions.
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-fps_mode",
          "cfr",
          "-r",
          `${payload.frameRate.num}/${payload.frameRate.den}`,
          // Constant-rate filling can hold the last frame past the source's
          // recorded duration; the asset keeps the duration it was probed with.
          "-t",
          String(asset.durationFrames / 30),
          "-c:v",
          "libx264",
          // The decoder's thread count is set before -i; the encoder's here.
          "-threads",
          String(RESOURCE_POLICY.enforced.renderThreads),
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
          "-fs",
          String(outputCap),
          "-progress",
          "pipe:1",
          "worker/derivative.mp4",
        ],
        cwd: dir,
        writable: [work],
        // The conversion may read only its source.
        readable: [source],
        memoryBytes: RESOURCE_POLICY.enforced.renderMemoryBytes,
        signal: controller.signal,
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
      })
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      });
    if (signal.aborted) throw new Error("Cancelled.");
    if (timedOut) throw new Error("Conversion time limit exceeded.");
    if (result.code !== 0)
      throw new Error(
        `FFmpeg failed to convert the source (exit ${result.code}).`,
        { cause: result.stderr },
      );
    // Probed and imported from the service's own copy of the main stream.
    const file = path.join(dir, "derivative.mp4");
    await keepMainStream(path.join(work, "derivative.mp4"), file);
    const probed = await probe(file);
    if (
      !probed.hasVideo ||
      probed.variableFrameRate ||
      probed.width !== even(asset.width) ||
      probed.height !== even(asset.height) ||
      Math.abs(probed.durationFrames - asset.durationFrames) > 2
    )
      throw new Error("Converted output failed verification.");
    this.#markValidating(jobId, attempt);
    // Held from before the copy is written until its rows commit (or it is
    // discarded), so no concurrent discard can remove the same bytes.
    const publication = await this.store.beginPublication(row.project_id);
    try {
      await this.#publishDerivative(row, attempt, asset, file, probed, () =>
        publication(),
      );
    } finally {
      publication();
    }
  }

  async #publishDerivative(
    row: Row,
    attempt: number,
    asset: Asset,
    file: string,
    probed: Awaited<ReturnType<typeof probe>>,
    endPublication: () => void,
  ) {
    const jobId = row.job_id;
    // The handle opens eagerly and closes before the attempt folder is
    // removed, so no deferred open can race that cleanup.
    const handle = await open(file, "r");
    let stored;
    try {
      stored = await this.store.importObject(
        row.project_id,
        handle.createReadStream({
          autoClose: false,
        }) as AsyncIterable<Uint8Array>,
      );
    } finally {
      await handle.close();
    }
    // The derivative joins the project as its own version, so an asset id is
    // always the version bound to its bytes; lineage names the original.
    const derived = AssetSchema.parse({
      ...asset,
      id: randomUUID(),
      extension: "mp4",
      hash: stored.sha256,
      bytes: stored.byteLength,
      width: probed.width,
      height: probed.height,
      durationFrames: probed.durationFrames,
    });
    await this.#cleanup(row.project_id, jobId, attempt);
    try {
      await this.#options.fault?.("before-succeed", jobId);
      await this.#attachDerivative(row, attempt, asset, derived, probed);
    } catch (e) {
      // Losing the commit leaves the published copy unregistered; remove it
      // unless another publication or row now shares those bytes.
      endPublication();
      await this.store.discardUnregisteredObject(row.project_id, derived.hash);
      throw e;
    }
  }

  #attachDerivative(
    row: Row,
    attempt: number,
    asset: Asset,
    derived: Asset,
    probed: Awaited<ReturnType<typeof probe>>,
  ) {
    return this.store.attachAsset(row.project_id, derived, (db) => {
      ProjectStore.registerDerivative(
        db,
        row.project_id,
        { id: derived.id, hash: derived.hash, bytes: derived.bytes },
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
      this.#succeedIn(db, row.job_id, attempt, `asset:${derived.id}`);
    });
  }

  // Queues the constant-rate conversion of a staged variable-frame-rate
  // source. The asset joins the project only when the conversion succeeds.
  async submitDerivative(
    projectId: string,
    staged: {
      asset: Asset;
      probe: {
        frameRate: { num: number; den: number } | null;
        averageFrameRate?: { num: number; den: number } | null;
      };
    },
  ) {
    if (this.#closing) throw new Error("Render queue is closing.");
    if (!this.#generation) await this.start();
    this.#current();
    const project = await this.store.load(projectId);
    const payload = DerivativePayload.parse({
      format: "cfr/1",
      asset: staged.asset,
      frameRate: standardRate(
        staged.probe.frameRate,
        staged.probe.averageFrameRate ?? null,
      ),
    });
    // Each upload stages its own version, so each gets its own conversion.
    const key = `cfr-${staged.asset.id}`;
    const row = this.store.transaction((db) => {
      this.#currentIn(db);
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
      // Conversions are long; a few per project leave room for exports.
      const converting = (
        db
          .prepare(
            `SELECT count(*) AS n FROM jobs WHERE project_id = ? AND kind = 'cfr-derivative' AND state NOT IN (${terminalSql})`,
          )
          .get(projectId) as { n: number }
      ).n;
      if (converting >= RESOURCE_POLICY.enforced.activeConversionsPerProject)
        throw new CommandError(
          "LIMIT_EXCEEDED",
          "Too many conversions are in progress for this project.",
        );
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

  // Inside a submission transaction: a newer service run has taken the
  // queue, so this supervisor would queue work it never runs.
  #currentIn(db: DatabaseSync) {
    const { generation } = db
      .prepare("SELECT generation FROM supervisor WHERE id = 1")
      .get() as { generation: number };
    if (this.#generation && generation !== this.#generation)
      this.#superseded = true;
    this.#current();
  }
  // Removes an emptied job folder unless a newer service run owns the
  // queue: that run may be creating its own attempt folder inside it.
  async #removeEmptyJobFolder(projectId: string, jobId: string) {
    const owned = this.store.read(
      (db) =>
        (
          db
            .prepare("SELECT generation FROM supervisor WHERE id = 1")
            .get() as {
            generation: number;
          }
        ).generation === this.#generation,
    );
    if (owned)
      await rmdir(await this.store.file(projectId, "exports", jobId)).catch(
        () => {},
      );
  }
  #current() {
    if (this.#superseded)
      throw new CommandError(
        "UNAVAILABLE",
        "A newer service run owns the job queue.",
      );
  }

  // Stops claiming work, terminates running workers and waits for the loop.
  async close() {
    this.#closing = true;
    for (const controller of this.#controllers.values()) controller.abort();
    await this.#loop;
  }
}

const even = (n: number) => n - (n % 2);

// Constant-rate targets: the nearest common rate to the source's rate. The
// nominal rate is used when plausible (it keeps every frame of a source that
// pauses); a nominal above 60 is often a time base or a peak (120 for 60 fps
// phone video), so the measured average is used instead, capped at 60, and
// anything unusable becomes 30. A 90000/1 tag never becomes the output rate.
const RATES = [
  [24000, 1001],
  [24, 1],
  [25, 1],
  [30000, 1001],
  [30, 1],
  [48, 1],
  [50, 1],
  [60000, 1001],
  [60, 1],
] as const;
type Rate = { num: number; den: number } | null;
const rateValue = (rate: Rate) =>
  rate && rate.den > 0 && rate.num > 0 ? rate.num / rate.den : 0;
function standardRate(nominal: Rate, average: Rate = null) {
  const declared = rateValue(nominal);
  const measured = rateValue(average);
  const target =
    declared > 0 && declared <= 60
      ? declared
      : measured > 0 && measured <= 120
        ? Math.min(measured, 60)
        : 30;
  const [num, den] = RATES.reduce((best, r) =>
    Math.abs(r[0] / r[1] - target) < Math.abs(best[0] / best[1] - target)
      ? r
      : best,
  );
  return { num, den };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
