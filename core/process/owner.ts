// Owned worker processes (plan T4/T5, contract "Durable jobs and owned
// processes"). On Windows every worker is launched through yamakan-procd,
// which creates it suspended and already inside its own kill-on-close Job
// Object; the worker only runs after the caller has recorded its identity
// (`onCreated`). If this service dies, procd sees its stdin close and ends
// every job; if procd dies, Windows closes the jobs. Elsewhere the owner runs
// in an explicitly unqualified development mode.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CommandError } from "../command/errors.ts";

export type Ownership = "windows-job-object" | "posix-unqualified";

export type RunOptions = {
  executable: string;
  args: string[];
  cwd: string;
  // Upper bound for the whole job's committed memory, in bytes (0 = none).
  memoryBytes?: number;
  signal?: AbortSignal;
  // Called with the worker's PID while it is still suspended (Windows).
  onCreated?: (pid: number) => void | Promise<void>;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  // Bound on retained stderr, returned with the result.
  stderrLimit?: number;
};
export type RunResult = { code: number; pid: number; stderr: string };

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
const unhex = (text: string) => Buffer.from(text, "hex").toString("utf8");

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
  exited: (code: number) => void;
  failed: (message: string) => void;
};

export class ProcessOwner {
  readonly ownership: Ownership;
  get ownerPid() {
    return this.#procd?.pid ?? null;
  }
  readonly #allow: string[];
  #procd: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<string, Pending>();
  #closed = false;

  constructor(allowedExecutables: string[]) {
    this.ownership =
      process.platform === "win32" ? "windows-job-object" : "posix-unqualified";
    this.#allow = allowedExecutables.map((e) => path.resolve(e));
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
    // The owner never keeps the service alive by itself: when the service
    // exits, procd sees its stdin close and ends every job.
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    this.#ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        const [kind, id, value] = line.split("\t");
        if (kind === "READY") return resolve();
        const p = this.#pending.get(id);
        if (!p) return;
        if (kind === "CREATED") p.created(Number(value));
        else if (kind === "EXITED") {
          this.#pending.delete(id);
          p.exited(Number(value));
        } else if (kind === "ERROR") {
          this.#pending.delete(id);
          p.failed(unhex(value || ""));
        }
      });
      child.once("error", reject);
      child.once("exit", () => {
        // The owner is gone, and with it every job it held.
        for (const [id, p] of this.#pending) {
          this.#pending.delete(id);
          p.failed("The process owner exited.");
        }
        this.#ready = null;
        this.#procd = null;
        reject(new Error("The process owner exited."));
      });
    });
    return this.#ready;
  }

  #send(line: string) {
    if (!this.#procd?.stdin?.writable)
      throw new CommandError(
        "UNAVAILABLE",
        "The process owner is not running.",
      );
    this.#procd.stdin.write(`${line}\n`);
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
    await this.#start();
    const id = randomUUID();
    const limit = options.stderrLimit ?? 64 * 1024;
    let stderr = "";
    // The worker's output pipes are created here, so only this service can read them.
    const pipe = async (suffix: string, sink: (b: Buffer) => void) => {
      const name = `\\\\.\\pipe\\yamakan-${id}-${suffix}`;
      const sockets: Socket[] = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => (resolveClosed = r));
      const server: Server = createServer((socket) => {
        sockets.push(socket);
        socket.on("data", sink);
        socket.on("close", resolveClosed);
        socket.on("error", resolveClosed);
        server.close();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });
      return { name, closed, server };
    };
    const out = await pipe("out", (b) => options.onStdout?.(b));
    const err = await pipe("err", (b) => {
      options.onStderr?.(b);
      stderr = (stderr + b.toString("utf8")).slice(-limit);
    });
    let pid = 0;
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const kill = () => this.#send(`KILL\t${id}`);
        this.#pending.set(id, {
          created: async (createdPid) => {
            pid = createdPid;
            try {
              if (options.signal?.aborted) return kill();
              await options.onCreated?.(createdPid);
              if (options.signal?.aborted) return kill();
              this.#send(`RESUME\t${id}`);
            } catch (e) {
              kill();
              reject(e);
            }
          },
          exited: (exitCode) => {
            options.signal?.removeEventListener("abort", kill);
            resolve(exitCode);
          },
          failed: (message) => {
            options.signal?.removeEventListener("abort", kill);
            reject(
              new CommandError(
                "CAPABILITY_UNAVAILABLE",
                `Worker launch failed: ${message}`,
              ),
            );
          },
        });
        options.signal?.addEventListener("abort", kill, { once: true });
        this.#send(
          [
            "SPAWN",
            id,
            hex(executable),
            hex(path.resolve(options.cwd)),
            hex(out.name),
            hex(err.name),
            String(options.memoryBytes ?? 0),
            String(options.args.length),
            ...options.args.map(hex),
          ].join("\t"),
        );
      });
      // Drain output written before exit (bounded wait: the pipes close with the job).
      await Promise.race([
        Promise.all([out.closed, err.closed]),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      return { code, pid, stderr };
    } finally {
      this.#pending.delete(id);
      out.server.close();
      err.server.close();
    }
  }

  // Development fallback outside Windows: no kernel-enforced ownership. The
  // service kills workers it knows about on shutdown, but a crash can orphan
  // them. Never presented as qualified.
  #runPosix(options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(path.resolve(options.executable), options.args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const limit = options.stderrLimit ?? 64 * 1024;
      let stderr = "";
      const kill = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", kill, { once: true });
      child.stdout!.on("data", (b: Buffer) => options.onStdout?.(b));
      child.stderr!.on("data", (b: Buffer) => {
        options.onStderr?.(b);
        stderr = (stderr + b.toString("utf8")).slice(-limit);
      });
      child.once("spawn", () => void options.onCreated?.(child.pid!));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        options.signal?.removeEventListener("abort", kill);
        resolve({
          code: code ?? (signal ? 1 : 0),
          pid: child.pid ?? 0,
          stderr,
        });
      });
    });
  }

  // Ends every job and the owner itself.
  close() {
    this.#closed = true;
    this.#procd?.stdin?.end();
  }
}
