// Reference preview (plan T8, contract "Canonical render plan"): frames and
// short segments rendered by the same plan compiler, filtergraph, ASS
// script and fonts as export, so what the preview shows is what the export
// will contain. Results are cached per project, keyed by everything that
// determines the pixels (plan hash, window, output kind, engine), and the
// cache is bounded in bytes; recently used entries are kept while a viewer
// is stepping or playing through them.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../store.ts";
import { CommandError } from "../command/errors.ts";
import { RESOURCE_POLICY } from "../command/policy.ts";
import { FLICKS_PER_SECOND } from "../time.ts";
import { mediaTools, workers } from "../process/workers.ts";
import { renderPlan } from "../render.ts";
import { compilePlan } from "./plan.ts";
import { titleFonts } from "./fonts.ts";

const FRAME_TICKS = FLICKS_PER_SECOND / 30;
// Entries used within this many milliseconds are never evicted: a viewer
// stepping or playing through them still needs them.
const PINNED_MS = 60_000;

export type PreviewKind = "frame" | "segment";
export type Preview = {
  file: string;
  contentType: "image/png" | "video/mp4";
  planHash: string;
  revision: number;
  cached: boolean;
};

let engine: Promise<string> | null = null;
// The renderer's identity: the FFmpeg build that draws previews and exports.
// A different build is a different cache.
function engineId() {
  engine ??= (async () => {
    let out = "";
    const result = await workers().run({
      executable: mediaTools().ffmpeg,
      args: ["-hide_banner", "-version"],
      cwd: tmpdir(),
      stderrLimit: 4000,
      onStdout: (chunk) => {
        if (out.length < 8000) out += chunk.toString("utf8");
      },
    });
    if (result.code !== 0)
      throw new CommandError(
        "CAPABILITY_UNAVAILABLE",
        "The renderer could not be identified.",
      );
    return createHash("sha256").update(out).digest("hex");
  })().catch((e) => {
    engine = null;
    throw e;
  });
  return engine;
}

// One preview render at a time per service; identical requests in flight
// share one render.
let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<Preview>>();

export async function preview(
  store: ProjectStore,
  projectId: string,
  revision: number,
  kind: PreviewKind,
  startFrame: number,
  frames = 1,
): Promise<Preview> {
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
  const total = Math.round(plan.durationTicks / FRAME_TICKS);
  if (startFrame >= total)
    throw new CommandError(
      "VALIDATION",
      "The preview starts after the end of the timeline.",
    );
  const count = Math.min(frames, total - startFrame);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        plan.planHash,
        kind,
        startFrame,
        count,
        await engineId(),
      ]),
    )
    .digest("hex");
  const ext = kind === "frame" ? "png" : "mp4";
  const dir = await store.file(projectId, "cache", "preview");
  const file = path.join(dir, `${key}.${ext}`);
  const result = (cached: boolean): Preview => ({
    file,
    contentType: kind === "frame" ? "image/png" : "video/mp4",
    planHash: plan.planHash,
    revision,
    cached,
  });
  const hit = await stat(file).catch(() => null);
  if (hit?.isFile()) {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    return result(true);
  }
  const running = inFlight.get(file);
  if (running) return running;
  const work = (async () => {
    const turn = queue.then(async () => {
      const staging = ["cache", "preview", `render-${randomUUID()}`];
      try {
        const { output } = await renderPlan(
          store,
          plan,
          ass,
          staging,
          new AbortController().signal,
          () => {},
          undefined,
          {
            startTicks: startFrame * FRAME_TICKS,
            durationTicks: count * FRAME_TICKS,
            output: kind === "frame" ? "png" : "mp4",
          },
        );
        await mkdir(dir, { recursive: true });
        await rename(output, file);
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
    return turn;
  })();
  inFlight.set(file, work);
  try {
    return await work;
  } finally {
    inFlight.delete(file);
  }
}

// Keeps the project's preview cache within its byte bound, removing the
// least recently used entries first; recently used ones and `keep` stay.
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
  for (const e of entries.sort((a, b) => a.used - b.used)) {
    if (total <= bound) break;
    if (e.file === keep || now - e.used < pinnedMs) continue;
    await unlink(e.file).catch(() => {});
    total -= e.size;
  }
}
