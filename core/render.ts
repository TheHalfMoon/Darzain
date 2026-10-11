import { writeFile, mkdir, unlink, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { ProjectSchema } from "./project.ts";
import type { Project } from "./project.ts";
import { ProjectStore } from "./store.ts";
import { probe } from "./media.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";
import { mediaTools, workers } from "./process/workers.ts";
export type RenderJob = {
  id: string;
  projectId: string;
  revision: number;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  error: string | null;
  artifact: string | null;
};
// Adapted from the donor's buildTimelineCommand: ordered overlays, source trimming,
// normalized timestamps, scale-to-fit, and a deterministic black canvas. Yamakan adds
// explicit audio mixing, safe title text files, cancellation and verified atomic output.
// Renders into a project-relative staging folder through an owned FFmpeg
// worker and returns the verified, unpublished output file. Publication and
// the terminal job state belong to the job supervisor (core/jobs.ts).
export async function renderProject(
  store: ProjectStore,
  p: Project,
  staging: string[],
  signal: AbortSignal,
  onProgress: (value: number) => void,
  onCreated?: (pid: number) => void | Promise<void>,
) {
  ProjectSchema.parse(p);
  const active = p.clips.filter((c) => {
    const track = p.tracks.find((t) => t.id === c.trackId)!;
    return (
      !track.muted &&
      (!p.tracks.some((t) => t.kind === track.kind && t.solo) || track.solo)
    );
  });
  if (
    !active.some(
      (c) => p.tracks.find((t) => t.id === c.trackId)?.kind === "video",
    )
  )
    throw new Error("Timeline has no active picture or title.");
  const duration =
    Math.max(...active.map((c) => c.startFrame + c.durationFrames)) / p.fps;
  const dir = await store.file(p.id, ...staging);
  await mkdir(dir, { recursive: true });
  if (active.some((c) => c.title !== null)) {
    const fonts = [
      process.env.YAMAKAN_FONT,
      process.env.DARZAIN_FONT,
      process.env.WINDIR ? `${process.env.WINDIR}/Fonts/arial.ttf` : null,
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/System/Library/Fonts/Supplemental/Arial.ttf",
    ].filter((x): x is string => Boolean(x));
    let font: string | undefined;
    for (const candidate of fonts) {
      try {
        await access(candidate);
        font = candidate;
        break;
      } catch {}
    }
    if (!font)
      throw new Error(
        "No local title font found. Configure YAMAKAN_FONT to a readable TTF font.",
      );
    await copyFile(font, `${dir}/font.ttf`);
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
  const filters = [
    `color=c=black:s=${p.width}x${p.height}:r=30:d=${duration},format=yuv420p[base]`,
  ];
  let visual = "base",
    input = 0;
  const audio: string[] = [];
  const ordered = [...active].sort(
    (a, b) =>
      p.tracks.findIndex((t) => t.id === a.trackId) -
        p.tracks.findIndex((t) => t.id === b.trackId) ||
      a.startFrame - b.startFrame ||
      a.id.localeCompare(b.id),
  );
  for (const c of ordered) {
    const start = c.startFrame / 30,
      end = (c.startFrame + c.durationFrames) / 30,
      len = c.durationFrames / 30;
    if (c.title !== null) {
      const textfile = `title-${c.id}.txt`;
      await writeFile(`${dir}/${textfile}`, c.title, { flag: "wx" });
      const next = `v${input++}`;
      filters.push(
        `[${visual}]drawtext=fontfile='font.ttf':textfile='${textfile}':expansion=none:fontsize=${Math.round(p.height / 15)}:fontcolor=white:x=(w-text_w)/2:y=h-text_h-40:box=1:boxcolor=black@0.65:boxborderw=12:enable='gte(t,${start})*lt(t,${end})'[${next}]`,
      );
      visual = next;
      continue;
    }
    const { file, asset } = await store.assetFile(p.id, c.assetId!);
    const index = args.filter((x) => x === "-i").length;
    args.push("-protocol_whitelist", "file");
    if (asset.kind === "image") args.push("-loop", "1", "-t", String(len));
    args.push("-i", file);
    if (asset.kind === "audio") {
      const label = `a${input++}`;
      filters.push(
        `[${index}:a]atrim=start=${c.sourceFrame / 30}:duration=${len},asetpts=PTS-STARTPTS,adelay=${Math.round(start * 1000)}:all=1[${label}]`,
      );
      audio.push(label);
    } else {
      const clip = `c${input}`,
        next = `v${input++}`;
      const trim =
        asset.kind === "image"
          ? `trim=duration=${len}`
          : `trim=start=${c.sourceFrame / 30}:duration=${len}`;
      filters.push(
        `[${index}:v]${trim},setpts=PTS-STARTPTS+${start}/TB,fps=30,scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,setsar=1[${clip}]`,
      );
      filters.push(
        `[${visual}][${clip}]overlay=x=(W-w)/2:y=(H-h)/2:enable='gte(t,${start})*lt(t,${end})':eof_action=pass[${next}]`,
      );
      visual = next;
    }
  }
  if (audio.length)
    filters.push(
      `${audio.map((a) => `[${a}]`).join("")}amix=inputs=${audio.length}:normalize=0,atrim=duration=${duration},alimiter=limit=0.95[audio]`,
    );
  args.push("-filter_complex", filters.join(";"), "-map", `[${visual}]`);
  if (audio.length) args.push("-map", "[audio]", "-c:a", "aac", "-b:a", "192k");
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
    "yuv420p",
    "-r",
    "30",
    "-t",
    String(duration),
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
    if (
      !probed.hasVideo ||
      probed.width !== p.width ||
      probed.height !== p.height ||
      Math.abs(probed.durationFrames - duration * 30) > 2 ||
      (audio.length && !probed.hasAudio)
    )
      throw new Error("Rendered output failed verification.");
    onProgress(1);
    return output;
  } catch (e) {
    await unlink(output).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
