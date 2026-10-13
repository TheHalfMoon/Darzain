// Owned worker processes (plan T4/T5, contract "Durable jobs and owned
// processes"). On Windows every worker is launched through yamakan-procd,
// which creates it suspended and already inside its own kill-on-close,
// single-process Job Object; the worker only runs after the caller has
// recorded its identity (`onCreated`). Output arrives over procd's own
// anonymous pipes. If this service dies, procd sees its stdin close and ends
// every job; if procd dies, Windows closes the jobs. Elsewhere the owner runs
// in an explicitly unqualified development mode.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CommandError } from "../command/errors.ts";

export type Ownership = "windows-job-object" | "posix-unqualified";
// How workers are owned on this host. Only Windows Job Objects are qualified.
export const ownershipMode = (): Ownership =>
  process.platform === "win32" ? "windows-job-object" : "posix-unqualified";

export type RunOptions = {
  executable: string;
  args: string[];
  cwd: string;
  // Upper bound for the whole job's committed memory, in bytes (0 = none).
  memoryBytes?: number;
  // The only folders the worker may write to (Windows: it runs at low
  // integrity, and these are labelled low while it runs). Absolute paths of
  // existing folders; at most 8. Anything else it can only read.
  writable?: string[];
  // The only files and folders the worker may read besides its executable
  // and system files (Windows: it runs in an AppContainer, and these are
  // granted to its own capability while it runs). Absolute paths; folders
  // include what is in them.
  readable?: string[];
  signal?: AbortSignal;
  // Called with the worker's PID while it is still suspended (Windows).
  onCreated?: (pid: number) => void | Promise<void>;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  // Bound on retained stderr, returned with the result.
  stderrLimit?: number;
};
export type RunResult = {
  code: number;
  pid: number;
  stderr: string;
  // Peak committed memory of the worker's Job Object (Windows); null where
  // no job measures it or procd could not read it.
  peakMemoryBytes: number | null;
};
// What every finished Windows worker reports to observers (qualification
// measures real product paths through this, not copies of their commands).
export type WorkerReport = {
  executable: string;
  code: number;
  // null: not measured (procd could not read the job, or predates the field).
  peakMemoryBytes: number | null;
  // 0: the run set no Job Object memory limit.
  memoryLimitBytes: number;
  wallMs: number;
};

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

function defaultProcd() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    "../../native/procd/target/release/yamakan-procd.exe",
  );
}

// Resolves a program name to an absolute path through PATH (and PATHEXT on
// Windows) once, so workers always run a fixed executable.
export function resolveExecutable(name: string): string {
  if (path.isAbsolute(name)) {
    if (!existsSync(name))
      throw new CommandError(
        "CAPABILITY_UNAVAILABLE",
        `${path.basename(name)} is not installed.`,
      );
    return name;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE").split(";").filter(Boolean)
      : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter))
    for (const ext of ["", ...extensions]) {
      const candidate = path.join(dir, name + ext);
      if (
        dir &&
        path.isAbsolute(candidate) &&
        existsSync(candidate) &&
        /\.exe$|^[^.]*$/i.test(path.basename(candidate))
      )
        return candidate;
    }
  throw new CommandError("CAPABILITY_UNAVAILABLE", `${name} is not installed.`);
}

type Pending = {
  created: (pid: number) => void;
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  // `restored`: the worker's writable folders are back to their default
  // label and inherited access.
  exited: (code: number, restored: boolean, peakBytes: number | null) => void;
  failed: (message: string) => void;
};

export class ProcessOwner {
  readonly ownership: Ownership;
  readonly #allow: string[];
  #procd: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<string, Pending>();
  #posix = new Set<ChildProcess>();
  // Runs in progress, from the first await until settled.
  #active = 0;
  #closed = false;
  #observers = new Set<(report: WorkerReport) => void>();

  constructor(allowedExecutables: string[]) {
    this.ownership = ownershipMode();
    this.#allow = allowedExecutables.map((e) => path.resolve(e));
  }
  get ownerPid() {
    return this.#procd?.pid ?? null;
  }

  // procd keeps the service alive only while work is pending; when the
  // service exits, procd sees its stdin close and ends every job.
  #refresh() {
    const child = this.#procd;
    if (!child) return;
    const streams = [child.stdin, child.stdout] as unknown as {
      ref?: () => void;
      unref?: () => void;
    }[];
    if (this.#active > 0) {
      child.ref();
      streams.forEach((s) => s.ref?.());
    } else {
      child.unref();
      streams.forEach((s) => s.unref?.());
    }
  }

  #start() {
    if (this.#ready) return this.#ready;
    const procd = process.env.YAMAKAN_PROCD || defaultProcd();
    if (!existsSync(procd))
      throw new CommandError(
        "CAPABILITY_UNAVAILABLE",
        "The process owner is not built; run npm run build:native.",
      );
    const child = spawn(procd, this.#allow, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.#procd = child;
    // A write after procd died must never crash the service.
    child.stdin!.on("error", () => {});
    this.#ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        const [kind, id, value, extra, peak] = line.split("\t");
        if (kind === "READY") return resolve();
        const p = this.#pending.get(id);
        if (!p) return;
        if (kind === "OUT") p.stdout(Buffer.from(value ?? "", "hex"));
        else if (kind === "ERR") p.stderr(Buffer.from(value ?? "", "hex"));
        else if (kind === "CREATED") p.created(Number(value));
        else if (kind === "EXITED")
          // A process that ran always committed memory: a missing or zero
          // peak means it was not measured.
          p.exited(
            Number(value),
            extra !== "0",
            Number(peak) > 0 ? Number(peak) : null,
          );
        else if (kind === "ERROR")
          p.failed(Buffer.from(value ?? "", "hex").toString("utf8"));
      });
      child.once("error", (e) => {
        // A failed start is retried on the next run, not cached.
        this.#ready = null;
        this.#procd = null;
        reject(e);
      });
      child.once("exit", () => {
        // The owner is gone, and with it every job it held.
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        this.#ready = null;
        this.#procd = null;
        for (const p of pending) p.failed("The process owner exited.");
        reject(new Error("The process owner exited."));
      });
    });
    this.#ready.catch(() => {});
    this.#refresh();
    return this.#ready;
  }

  // Returns false when procd is gone; its jobs died with it.
  #send(line: string) {
    const stdin = this.#procd?.stdin;
    if (!stdin?.writable) return false;
    stdin.write(`${line}\n`);
    return true;
  }

  async run(options: RunOptions): Promise<RunResult> {
    if (this.#closed)
      throw new CommandError("UNAVAILABLE", "The process owner is closed.");
    const executable = path.resolve(options.executable);
    if (!this.#allow.some((a) => a.toLowerCase() === executable.toLowerCase()))
      throw new CommandError(
        "VALIDATION",
        "Executable is not on the worker allowlist.",
      );
    if (this.ownership !== "windows-job-object") return this.#runPosix(options);
    this.#active++;
    try {
      return await this.#runOwned(options, executable);
    } finally {
      this.#active--;
      this.#refresh();
    }
  }

  async #runOwned(options: RunOptions, executable: string): Promise<RunResult> {
    await this.#start();
    const id = randomUUID();
    const limit = options.stderrLimit ?? 64 * 1024;
    let stderr = "";
    let pid = 0;
    let peakMemoryBytes: number | null = null;
    const started = performance.now();
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const kill = () => void this.#send(`KILL\t${id}`);
        const settle = () => options.signal?.removeEventListener("abort", kill);
        this.#pending.set(id, {
          created: (createdPid) => {
            pid = createdPid;
            void (async () => {
              try {
                if (options.signal?.aborted) return kill();
                await options.onCreated?.(createdPid);
                if (options.signal?.aborted || !this.#send(`RESUME\t${id}`))
                  kill();
              } catch (e) {
                kill();
                settle();
                this.#pending.delete(id);
                this.#refresh();
                reject(e);
              }
            })();
          },
          stdout: (chunk) => options.onStdout?.(chunk),
          stderr: (chunk) => {
            options.onStderr?.(chunk);
            stderr = (stderr + chunk.toString("utf8")).slice(-limit);
          },
          exited: (exitCode, restored, peakBytes) => {
            settle();
            peakMemoryBytes = peakBytes;
            this.#report({
              executable: path.basename(executable),
              code: exitCode,
              peakMemoryBytes: peakBytes,
              memoryLimitBytes: options.memoryBytes ?? 0,
              wallMs: performance.now() - started,
            });
            // A folder the worker left in a state procd could not undo is
            // reported, never ignored: the run fails with the reason.
            if (restored) resolve(exitCode);
            else
              reject(
                new CommandError(
                  "RECOVERY_REQUIRED",
                  "A worker's folder could not be restored to the workspace's access after it ran.",
                ),
              );
          },
          failed: (message) => {
            settle();
            reject(
              new CommandError(
                "CAPABILITY_UNAVAILABLE",
                `Worker launch failed: ${message}`,
              ),
            );
          },
        });
        this.#refresh();
        options.signal?.addEventListener("abort", kill, { once: true });
        const sent = this.#send(
          [
            "SPAWN",
            id,
            hex(executable),
            hex(path.resolve(options.cwd)),
            String(options.memoryBytes ?? 0),
            String(options.writable?.length ?? 0),
            ...(options.writable ?? []).map((d) => hex(path.resolve(d))),
            String(options.readable?.length ?? 0),
            ...(options.readable ?? []).map((p) => hex(path.resolve(p))),
            String(options.args.length),
            ...options.args.map(hex),
          ].join("\t"),
        );
        if (!sent) {
          settle();
          reject(
            new CommandError(
              "UNAVAILABLE",
              "The process owner is not running.",
            ),
          );
        }
      });
      return { code, pid, stderr, peakMemoryBytes };
    } finally {
      this.#pending.delete(id);
    }
  }

  // Development fallback outside Windows: no kernel-enforced ownership. Known
  // workers get a minimal environment and are killed on close, but a service
  // crash can orphan them. Reported as "posix-unqualified", never as qualified.
  #runPosix(options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "TMPDIR", "LANG"])
        if (process.env[key]) env[key] = process.env[key];
      const child = spawn(path.resolve(options.executable), options.args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#posix.add(child);
      const limit = options.stderrLimit ?? 64 * 1024;
      let stderr = "";
      const kill = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", kill, { once: true });
      child.stdout!.on("data", (b: Buffer) => options.onStdout?.(b));
      child.stderr!.on("data", (b: Buffer) => {
        options.onStderr?.(b);
        stderr = (stderr + b.toString("utf8")).slice(-limit);
      });
      child.once("spawn", () => {
        Promise.resolve(options.onCreated?.(child.pid!)).catch((e) => {
          kill();
          reject(e);
        });
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.#posix.delete(child);
        options.signal?.removeEventListener("abort", kill);
        resolve({
          code: code ?? (signal ? 1 : 0),
          pid: child.pid ?? 0,
          stderr,
          peakMemoryBytes: null,
        });
      });
    });
  }

  // Observers see every finished Windows worker; returns an unsubscribe.
  observe(listener: (report: WorkerReport) => void) {
    this.#observers.add(listener);
    return () => void this.#observers.delete(listener);
  }
  #report(report: WorkerReport) {
    // An observer is diagnostics: its failure, synchronous or async, never
    // affects the run it observes.
    for (const listener of this.#observers) {
      try {
        const returned: unknown = listener(report);
        if (returned instanceof Promise) returned.catch(() => {});
      } catch {}
    }
  }

  // Ends every job (and every known POSIX worker) and the owner itself.
  close() {
    this.#closed = true;
    for (const child of this.#posix) child.kill("SIGKILL");
    this.#procd?.stdin?.end();
  }
}
