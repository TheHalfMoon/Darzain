import { spawn } from "node:child_process";
import {
  writeFile,
  mkdir,
  rename,
  unlink,
  copyFile,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProjectSchema } from "./project.ts";
import type { Project } from "./project.ts";
import { ProjectStore } from "./store.ts";
import { probe } from "./media.ts";
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
export async function renderProject(
  store: ProjectStore,
  p: Project,
  jobId: string,
  signal: AbortSignal,
  onProgress: (value: number) => void,
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
  const dir = await store.file(p.id, "exports", jobId);
  await mkdir(dir, { recursive: false });
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
    "2",
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
    args.push("-protocol_whitelist", "file,pipe");
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
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cancelled."));
        return;
      }
      const child = spawn(
        process.env.YAMAKAN_FFMPEG || process.env.DARZAIN_FFMPEG || "ffmpeg",
        args,
        {
          cwd: dir,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let error = "",
        progress = "";
      const cancel = () => child.kill();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        error = "Render time limit exceeded.";
        child.kill();
      }, 180000);
      child.stdout.on("data", (chunk) => {
        progress += String(chunk);
        const lines = progress.split("\n");
        progress = lines.pop() || "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match)
            onProgress(Math.min(0.99, Number(match[1]) / 1e6 / duration));
        }
      });
      child.stderr.on("data", (chunk) => {
        error = (error + String(chunk)).slice(-8000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) reject(new Error("Cancelled."));
        else if (code !== 0)
          reject(new Error(error || `FFmpeg exited ${code}`));
        else resolve();
      });
    });
    const output = await store.file(
      p.id,
      "exports",
      jobId,
      "render.partial.mp4",
    );
    const result = await probe(output);
    if (
      !result.hasVideo ||
      result.width !== p.width ||
      result.height !== p.height ||
      Math.abs(result.durationFrames - duration * 30) > 2 ||
      (audio.length && !result.hasAudio)
    )
      throw new Error("Rendered output failed verification.");
    const completed = await store.file(p.id, "exports", jobId, "render.mp4");
    if (signal.aborted) throw new Error("Cancelled.");
    await rename(output, completed);
    if (signal.aborted) {
      await unlink(completed);
      throw new Error("Cancelled.");
    }
    onProgress(1);
    return `exports/${jobId}/render.mp4`;
  } catch (e) {
    await unlink(
      await store.file(p.id, "exports", jobId, "render.partial.mp4"),
    ).catch(() => {});
    throw e;
  }
}
export class RenderQueue {
  private jobs = new Map<string, RenderJob>();
  private controllers = new Map<string, AbortController>();
  private tail = Promise.resolve();
  private keys = new Map<string, string>();
  private closing = false;
  readonly store: ProjectStore;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) this.cancel(job.id);
    await this.tail;
  }
  list() {
    return [...this.jobs.values()];
  }
  status(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job not found.");
    return { ...job };
  }
  async submit(projectId: string, key: string) {
    if (this.closing) throw new Error("Render queue is closing.");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key))
      throw new Error("Invalid idempotency key.");
    const p = await this.store.load(projectId);
    if (this.closing) throw new Error("Render queue is closing.");
    const fingerprint = `${p.id}:${p.revision}:${key}`;
    const prior = this.keys.get(fingerprint);
    if (prior) return this.status(prior);
    if (this.jobs.size >= 100) throw new Error("Job session limit reached.");
    const id = randomUUID(),
      controller = new AbortController();
    const job: RenderJob = {
      id,
      projectId,
      revision: p.revision,
      state: "QUEUED",
      progress: 0,
      error: null,
      artifact: null,
    };
    this.jobs.set(id, job);
    this.keys.set(fingerprint, id);
    this.controllers.set(id, controller);
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        if (controller.signal.aborted) return;
        job.state = "RUNNING";
        try {
          job.artifact = await renderProject(
            this.store,
            p,
            id,
            controller.signal,
            (n) => (job.progress = n),
          );
          if (controller.signal.aborted) {
            await unlink(
              await this.store.file(p.id, ...job.artifact.split("/")),
            ).catch(() => {});
            job.artifact = null;
            throw new Error("Cancelled.");
          }
          job.state = "COMPLETED";
        } catch (e) {
          job.state = controller.signal.aborted ? "CANCELLED" : "FAILED";
          job.error = controller.signal.aborted
            ? null
            : e instanceof Error
              ? e.message
              : "Render failed.";
        } finally {
          this.controllers.delete(id);
        }
      });
    return { ...job };
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job not found.");
    if (["QUEUED", "RUNNING"].includes(job.state)) {
      this.controllers.get(id)?.abort();
      if (job.state === "QUEUED") {
        job.state = "CANCELLED";
        this.controllers.delete(id);
      }
    }
    return { ...job };
  }
}
