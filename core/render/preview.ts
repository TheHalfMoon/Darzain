// Reference preview (plan T8, contract "Canonical render plan"): frames and
// short segments rendered by the same plan compiler, filtergraph, ASS
// script and fonts as export, so what the preview shows is what the export
// will contain. Results are cached per project, keyed by everything that
// determines the pixels (plan hash, window, output kind, renderer version,
// FFmpeg build). The cache is bounded in bytes: least recently used entries
// go first; entries used within the last minute are kept while the cache
// is under twice its bound, and never above it.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { ProjectStore } from "../store.ts";
import { CommandError } from "../command/errors.ts";
import { RESOURCE_POLICY } from "../command/policy.ts";
import { FLICKS_PER_SECOND } from "../time.ts";
import { mediaTools, workers } from "../process/workers.ts";
import { RENDERER_VERSION, renderPlan } from "../render.ts";
import { compilePlan } from "./plan.ts";
import { titleFonts } from "./fonts.ts";

const FRAME_TICKS = FLICKS_PER_SECOND / 30;
// Entries used within this many milliseconds are kept while the cache is
// under twice its bound: a viewer stepping or playing through them still
// needs them.
const PINNED_MS = 60_000;

export type PreviewKind = "frame" | "segment";
export type Preview = {
  file: string;
  contentType: "image/png" | "video/mp4";
  planHash: string;
  revision: number;
  // The window actually shown, clamped to the saved timeline.
  startFrame: number;
  frames: number;
  cached: boolean;
};

let engine: Promise<string> | null = null;
// The renderer's identity: the FFmpeg build that draws previews and exports.
// A different build is a different cache.
function engineId(cwd: string) {
  engine ??= (async () => {
    let out = "";
    const result = await workers().run({
      executable: mediaTools().ffmpeg,
      args: ["-hide_banner", "-version"],
      cwd,
      memoryBytes: RESOURCE_POLICY.enforced.workerMemoryBytes,
      signal: AbortSignal.timeout(
        RESOURCE_POLICY.enforced.probeWallSeconds * 1000,
      ),
      stderrLimit: 4000,
      onStdout: (chunk) => {
        if (out.length < 8000) out += chunk.toString("utf8");
      },
    });
    if (result.code !== 0) throw new Error("ffmpeg -version failed.");
    return createHash("sha256").update(out).digest("hex");
  })().catch((cause) => {
    engine = null;
    throw new CommandError(
      "CAPABILITY_UNAVAILABLE",
      "The renderer could not be identified.",
      { cause },
    );
  });
  return engine;
}

// One preview render at a time per service. A render shared by identical
// requests runs while at least one of them still waits; it is abandoned
// (or stopped) when the last one leaves. At most previewQueueDepth renders
// wait; further requests are refused as BUSY (retryable).
type Pending = {
  promise: Promise<Preview>;
  controller: AbortController;
  waiters: number;
};
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
const inFlight = new Map<string, Pending>();
let closed = false;

export async function preview(
  store: ProjectStore,
  projectId: string,
  revision: number,
  kind: PreviewKind,
  startFrame: number,
  frames = 1,
  signal?: AbortSignal,
): Promise<Preview> {
  if (closed) throw new CommandError("UNAVAILABLE", "The service is closing.");
  const limit = RESOURCE_POLICY.enforced.previewSegmentFrames;
  if (
    !Number.isSafeInteger(startFrame) ||
    startFrame < 0 ||
    !Number.isSafeInteger(frames) ||
    frames < 1 ||
    frames > limit ||
    (kind === "frame" && frames !== 1)
  )
    throw new CommandError(
      "VALIDATION",
      `A preview is one frame or a segment of at most ${limit} frames.`,
    );
  const { project, snapshotHash } = store.revisionCanonical(
    projectId,
    revision,
  );
  const { plan, ass } = compilePlan(project, snapshotHash, await titleFonts());
  // A playhead past the saved timeline (an unsaved clip added at the end, a
  // muted trailing track) shows the saved timeline's last frame.
  const total = Math.round(plan.durationTicks / FRAME_TICKS);
  const start = Math.min(startFrame, total - 1);
  const count = Math.min(frames, total - start);
  const dir = await store.file(projectId, "cache", "preview");
  await mkdir(dir, { recursive: true });
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        plan.planHash,
        kind,
        start,
        count,
        RENDERER_VERSION,
        await engineId(dir),
      ]),
    )
    .digest("hex");
  const file = path.join(dir, `${key}.${kind === "frame" ? "png" : "mp4"}`);
  const result = (cached: boolean): Preview => ({
    file,
    contentType: kind === "frame" ? "image/png" : "video/mp4",
    planHash: plan.planHash,
    revision,
    startFrame: start,
    frames: count,
    cached,
  });
  // A render everyone left is never joined: a new request starts afresh.
  const live = () => {
    const entry = inFlight.get(file);
    return entry && !entry.controller.signal.aborted ? entry : undefined;
  };
  let pending = live();
  if (!pending) {
    const hit = await stat(file).catch(() => null);
    if (hit?.isFile()) {
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      return result(true);
    }
    pending = live();
  }
  if (!pending) {
    if (waiting >= RESOURCE_POLICY.enforced.previewQueueDepth)
      throw new CommandError(
        "BUSY",
        "Too many previews are being rendered; retry shortly.",
      );
    const controller = new AbortController();
    waiting++;
    const turn = queue.then(async () => {
      waiting--;
      if (controller.signal.aborted) throw new Error("Cancelled.");
      await removeStaleStaging(dir);
      // Rendering writes a frame or segment; the import reserve stays free.
      const space = await statfs(dir);
      if (
        Number(space.bavail) * Number(space.bsize) <
        RESOURCE_POLICY.enforced.diskReserveBytes
      )
        throw new CommandError(
          "LIMIT_EXCEEDED",
          "Not enough free disk space to render a preview.",
        );
      const staging = ["cache", "preview", `render-${randomUUID()}`];
      try {
        const { output } = await renderPlan(
          store,
          plan,
          ass,
          staging,
          controller.signal,
          () => {},
          undefined,
          {
            startTicks: start * FRAME_TICKS,
            durationTicks: count * FRAME_TICKS,
            output: kind === "frame" ? "png" : "mp4",
            wallSeconds: RESOURCE_POLICY.enforced.previewWallSeconds,
          },
        );
        await rename(output, file).catch(async (e) => {
          // Another render of the same key won; its file is the same.
          if (!(await stat(file).catch(() => null))?.isFile()) throw e;
        });
      } finally {
        await rm(await store.file(projectId, ...staging), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
      await evictPreviews(dir, file);
      return result(false);
    });
    queue = turn.catch(() => {});
    pending = { promise: turn, controller, waiters: 0 };
    const entry = pending;
    inFlight.set(file, entry);
    turn
      .finally(() => {
        if (inFlight.get(file) === entry) inFlight.delete(file);
      })
      .catch(() => {});
  }
  const entry = pending;
  entry.waiters++;
  const leave = () => {
    entry.waiters--;
    if (entry.waiters === 0) entry.controller.abort();
  };
  if (signal?.aborted) {
    leave();
    throw new Error("Cancelled.");
  }
  signal?.addEventListener("abort", leave, { once: true });
  try {
    return await entry.promise;
  } finally {
    if (!signal?.aborted) {
      signal?.removeEventListener("abort", leave);
      entry.waiters--;
    }
  }
}

// Renders waiting for their turn (for status and tests).
export function previewsWaiting() {
  return waiting;
}

// Stops waiting and running preview renders (service shutdown).
export async function closePreviews() {
  closed = true;
  for (const entry of inFlight.values()) entry.controller.abort();
  await queue;
}

// Staging folders a crashed or stopped render left behind.
async function removeStaleStaging(dir: string) {
  const limit = RESOURCE_POLICY.enforced.previewWallSeconds * 2000;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^render-[0-9a-f-]{36}$/.test(name)) continue;
    const folder = path.join(dir, name);
    const info = await stat(folder).catch(() => null);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > limit)
      await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

// Keeps the project's preview cache within its byte bound, removing the
// least recently used entries first. Entries used within `pinnedMs` are
// kept while the cache is under twice the bound; above that, recency
// protects nothing, so the cache never exceeds twice its bound.
export async function evictPreviews(
  dir: string,
  keep: string,
  bound: number = RESOURCE_POLICY.enforced.previewCacheBytes,
  pinnedMs = PINNED_MS,
) {
  const entries = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.(png|mp4)$/.test(name)) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile())
      entries.push({ file, size: info.size, used: info.mtimeMs });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  const now = Date.now();
  const byAge = entries.sort((a, b) => a.used - b.used);
  for (const e of byAge) {
    if (total <= bound) break;
    if (e.file === keep || now - e.used < pinnedMs) continue;
    await unlink(e.file).catch(() => {});
    total -= e.size;
    e.size = 0;
  }
  for (const e of byAge) {
    if (total <= 2 * bound) break;
    if (e.file === keep || e.size === 0) continue;
    await unlink(e.file).catch(() => {});
    total -= e.size;
  }
}
