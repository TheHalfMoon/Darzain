import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ProjectStore } from "./store.ts";
import { MEDIA_FORMATS, probe } from "./media.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";
import { CommandError } from "./command/errors.ts";
import { FLICKS_PER_SECOND } from "./time.ts";
import { mediaTools, workers } from "./process/workers.ts";
import { compilePlan } from "./render/plan.ts";
import type { RenderPlan } from "./render/plan.ts";
import { titleFonts } from "./render/fonts.ts";
import type { PinnedFont } from "./render/fonts.ts";
import { compileTitles } from "./render/ass.ts";
import { titleCapability } from "./render/capability.ts";
export type RenderJob = {
  id: string;
  projectId: string;
  revision: number;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  error: string | null;
  artifact: string | null;
  // The render plan a completed export drew (contract: async results carry
  // their planHash); null for other jobs and before completion.
  planHash: string | null;
};

// Seconds as an exact-enough decimal string from integer flicks (truncated
// to the nanosecond): the only way time enters the filtergraph.
export function seconds(ticks: number): string {
  if (!Number.isSafeInteger(ticks) || ticks < 0)
    throw new CommandError("VALIDATION", "Render time is out of range.");
  const ns = (BigInt(ticks) * 1_000_000_000n) / BigInt(FLICKS_PER_SECOND);
  const whole = ns / 1_000_000_000n;
  const frac = (ns % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${frac}`;
}

// libass breaks lines only at spaces, so an unbreakable run wider than the
// frame would be cut off at its edges. Each title is drawn alone for one
// frame by the same libass and fonts, and only the frame's outermost pixel
// columns are read back: ink there means the title does not fit, and the
// render is refused rather than silently clipped.
async function assertTitlesFit(
  dir: string,
  plan: RenderPlan,
  fonts: PinnedFont[],
  signal: AbortSignal,
) {
  const { width, height } = plan.profile;
  const frame = FLICKS_PER_SECOND / 30;
  const cues = plan.titles!.cues.map((cue, i) => ({
    ...cue,
    startTicks: i * frame,
    endTicks: (i + 1) * frame,
  }));
  await writeFile(
    path.join(dir, "measure.ass"),
    compileTitles(cues, width, height, fonts).ass,
    { flag: "wx" },
  );
  const chunks: Buffer[] = [];
  const result = await workers().run({
    executable: mediaTools().ffmpeg,
    args: [
      "-hide_banner",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${width}x${height}:r=30:d=${seconds(cues.length * frame)}`,
      "-filter_complex",
      "[0:v]ass=measure.ass:fontsdir=fonts,format=gray,split[a][b];[a]crop=1:ih:0:0[l];[b]crop=1:ih:iw-1:0[r];[l][r]hstack[edges]",
      "-map",
      "[edges]",
      "-frames:v",
      String(cues.length),
      "-f",
      "rawvideo",
      "-",
    ],
    cwd: dir,
    memoryBytes: RESOURCE_POLICY.enforced.renderMemoryBytes,
    signal,
    stderrLimit: 8000,
    onStdout: (chunk) => chunks.push(chunk),
  });
  if (signal.aborted) throw new Error("Cancelled.");
  const edges = Buffer.concat(chunks);
  const perFrame = 2 * height;
  if (result.code !== 0 || edges.length !== perFrame * cues.length)
    throw new Error("Title layout could not be checked.", {
      cause: result.stderr,
    });
  for (let i = 0; i < cues.length; i++) {
    const columns = edges.subarray(i * perFrame, (i + 1) * perFrame);
    if (columns.some((value) => value > 96))
      throw new CommandError(
        "VALIDATION",
        `Title ${i + 1} is wider than the frame; shorten long words or add spaces so it can wrap.`,
      );
  }
}

export type RenderReceipt = {
  planHash: string;
  width: number;
  height: number;
  durationFrames: number;
  hasAudio: boolean;
};

// Adapted from the donor's buildTimelineCommand: ordered overlays, source trimming,
// normalized timestamps, scale-to-fit, and a deterministic black canvas. Yamakan adds
// explicit audio mixing, cancellation and verified atomic output. T7: the
// filtergraph is compiled only from a render plan (core/render/plan.ts):
// numbers formatted from integer ticks, asset files verified against the
// plan's hashes, and titles drawn by one ASS script with the pinned fonts.
// Renders into a project-relative staging folder through an owned FFmpeg
// worker and returns the verified, unpublished output file and its receipt.
// Publication and the terminal job state belong to the job supervisor.
export async function renderPlan(
  store: ProjectStore,
  plan: RenderPlan,
  ass: string | null,
  staging: string[],
  signal: AbortSignal,
  onProgress: (value: number) => void,
  onCreated?: (pid: number) => void | Promise<void>,
): Promise<{ output: string; receipt: RenderReceipt }> {
  const { profile } = plan;
  const rate = `${profile.fps.num}/${profile.fps.den}`;
  const total = seconds(plan.durationTicks);
  const dir = await store.file(plan.projectId, ...staging);
  await mkdir(dir, { recursive: true });
  if (plan.titles) {
    if (ass === null)
      throw new CommandError(
        "VALIDATION",
        "The plan's title script is missing.",
      );
    await titleCapability();
    // The pinned font files, verified, are the only fonts libass is given.
    const fonts = await titleFonts();
    if (
      plan.fonts.length !== fonts.length ||
      plan.fonts.some((f, i) => f.sha256 !== fonts[i].sha256)
    )
      throw new CommandError(
        "RECOVERY_REQUIRED",
        "The plan was compiled with different title fonts.",
      );
    await mkdir(path.join(dir, "fonts"));
    for (const font of fonts)
      await writeFile(path.join(dir, "fonts", font.name), font.bytes, {
        flag: "wx",
      });
    await writeFile(path.join(dir, "titles.ass"), ass, { flag: "wx" });
    await assertTitlesFit(dir, plan, fonts, signal);
  }
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-threads",
    String(RESOURCE_POLICY.enforced.renderThreads),
    "-filter_complex_threads",
    "1",
  ];
  const inputs = new Map<string, number>();
  const input = async (
    assetId: string,
    sha256: string,
    still: boolean,
    len: string,
  ) => {
    const key = still ? `${assetId}:${len}` : assetId;
    const known = inputs.get(key);
    if (known !== undefined) return known;
    const { file, asset } = await store.assetFile(plan.projectId, assetId);
    if (asset.hash !== sha256)
      throw new CommandError(
        "RECOVERY_REQUIRED",
        "An asset no longer matches the render plan.",
      );
    args.push(
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      MEDIA_FORMATS,
    );
    if (still) args.push("-loop", "1", "-t", len);
    args.push("-i", file);
    const index = inputs.size;
    inputs.set(key, index);
    return index;
  };
  const filters = [
    `color=c=black:s=${profile.width}x${profile.height}:r=${rate}:d=${total},format=yuv420p[base]`,
  ];
  let visual = "base";
  let n = 0;
  for (const layer of plan.layers) {
    const start = seconds(layer.startTicks);
    const end = seconds(layer.startTicks + layer.durationTicks);
    const len = seconds(layer.durationTicks);
    const still = layer.kind === "image";
    const index = await input(layer.assetId, layer.assetSha256, still, len);
    const clip = `c${n}`,
      next = `v${n++}`;
    const trim = still
      ? `trim=duration=${len}`
      : `trim=start=${seconds(layer.sourceStartTicks)}:duration=${len}`;
    filters.push(
      `[${index}:v]${trim},setpts=PTS-STARTPTS+${start}/TB,fps=${rate},scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,setsar=1[${clip}]`,
      `[${visual}][${clip}]overlay=x=(W-w)/2:y=(H-h)/2:enable='gte(t,${start})*lt(t,${end})':eof_action=pass[${next}]`,
    );
    visual = next;
  }
  const audio: string[] = [];
  for (const a of plan.audio) {
    const len = seconds(a.durationTicks);
    const index = await input(a.assetId, a.assetSha256, false, len);
    const label = `a${n++}`;
    // Gain and linear fades are plan numbers, applied in the clip's own time
    // before it is placed on the timeline.
    const shaping = [
      a.gainDb ? `volume=${a.gainDb}dB` : null,
      a.fadeInTicks ? `afade=t=in:st=0:d=${seconds(a.fadeInTicks)}` : null,
      a.fadeOutTicks
        ? `afade=t=out:st=${seconds(a.durationTicks - a.fadeOutTicks)}:d=${seconds(a.fadeOutTicks)}`
        : null,
    ].filter(Boolean);
    const delayMs = (BigInt(a.startTicks) * 1000n) / BigInt(FLICKS_PER_SECOND);
    filters.push(
      `[${index}:a]atrim=start=${seconds(a.sourceStartTicks)}:duration=${len},asetpts=PTS-STARTPTS,${shaping.map((f) => `${f},`).join("")}aresample=${profile.sampleRate},adelay=${delayMs}:all=1[${label}]`,
    );
    audio.push(label);
  }
  if (plan.titles) {
    filters.push(`[${visual}]ass=titles.ass:fontsdir=fonts[titled]`);
    visual = "titled";
  }
  if (audio.length)
    filters.push(
      `${audio.map((a) => `[${a}]`).join("")}amix=inputs=${audio.length}:normalize=0,atrim=duration=${total},alimiter=limit=0.95[audio]`,
    );
  args.push("-filter_complex", filters.join(";"), "-map", `[${visual}]`);
  if (audio.length)
    args.push(
      "-map",
      "[audio]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      String(profile.sampleRate),
    );
  args.push(
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    profile.pixelFormat,
    "-r",
    rate,
    "-t",
    total,
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "render.partial.mp4",
  );
  const output = path.join(dir, "render.partial.mp4");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESOURCE_POLICY.enforced.renderWallSeconds * 1000);
  const duration = Number(total);
  let progress = "";
  try {
    if (signal.aborted) throw new Error("Cancelled.");
    const result = await workers().run({
      executable: mediaTools().ffmpeg,
      args,
      cwd: dir,
      memoryBytes: RESOURCE_POLICY.enforced.renderMemoryBytes,
      signal: controller.signal,
      onCreated,
      stderrLimit: 8000,
      onStdout: (chunk) => {
        progress += chunk.toString("utf8");
        const lines = progress.split("\n");
        progress = lines.pop() || "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match)
            onProgress(Math.min(0.99, Number(match[1]) / 1e6 / duration));
        }
      },
    });
    if (signal.aborted) throw new Error("Cancelled.");
    if (timedOut) throw new Error("Render time limit exceeded.");
    // Public messages never carry FFmpeg stderr, which contains host paths;
    // the bounded stderr tail stays server-side as the error cause.
    if (result.code !== 0)
      throw new Error(
        `FFmpeg failed to render the timeline (exit ${result.code}).`,
        { cause: result.stderr },
      );
    const probed = await probe(output);
    const expectedFrames = Math.round(duration * 30);
    if (
      !probed.hasVideo ||
      probed.width !== profile.width ||
      probed.height !== profile.height ||
      Math.abs(probed.durationFrames - expectedFrames) > 2 ||
      (audio.length > 0 && !probed.hasAudio)
    )
      throw new Error("Rendered output failed verification.");
    onProgress(1);
    return {
      output,
      receipt: {
        planHash: plan.planHash,
        width: probed.width,
        height: probed.height,
        durationFrames: probed.durationFrames,
        hasAudio: probed.hasAudio,
      },
    };
  } catch (e) {
    await unlink(output).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// Compiles the render plan of a stored revision and renders it: the one
// export path (jobs) and, in T8, reference preview.
export async function renderRevision(
  store: ProjectStore,
  projectId: string,
  revision: number,
  staging: string[],
  signal: AbortSignal,
  onProgress: (value: number) => void,
  onCreated?: (pid: number) => void | Promise<void>,
) {
  const { project, snapshotHash } = store.revisionCanonical(
    projectId,
    revision,
  );
  const { plan, ass } = compilePlan(project, snapshotHash, await titleFonts());
  const rendered = await renderPlan(
    store,
    plan,
    ass,
    staging,
    signal,
    onProgress,
    onCreated,
  );
  return { plan, ...rendered };
}
