// Export golden comparison (docs/E2E_ACCEPTANCE.md, "Preview/export and text
// comparison"). Decodes exported frames and audio with the pinned FFmpeg and
// checks them against an expectation written as intent: which colour each
// probe region shows on each frame, where a title is present, how the frame
// compares with the reference still, when audio starts. The metrics and
// tolerances are locked here, before qualification; a failing check returns
// a reason, never throws, so negative fixtures can assert the reason.
import { execFileSync } from "node:child_process";
import { mediaTools } from "../../core/process/workers.ts";

export type Rgb = [number, number, number];
export type Region = { x: number; y: number; w: number; h: number };
export type Frame = { width: number; height: number; rgb: Buffer };

// Locked tolerances.
export const TOLERANCE = Object.freeze({
  // Whole-frame SSIM (luma, 8x8 windows every 4 pixels, as x264/FFmpeg)
  // between a decoded export frame and the reference still of the same
  // frame: the plan's proposed reference-path floor.
  frameSsim: 0.98,
  // Title region SSIM against the reference still's title region.
  titleSsim: 0.95,
  // A title is present when at least this share of its region differs from
  // the clip colour beneath it by more than titleContrast (sum over RGB).
  titlePixelShare: 0.004,
  titleContrast: 150,
  // Audio onset: first sample above this share of full scale.
  audioThreshold: 0.1,
  audioOnsetMs: 20,
  // Duration: within one frame.
  durationFrames: 1,
  // A probe region's mean colour must be within this of its palette colour
  // on every channel (not merely nearest), so a range or matrix error in a
  // conversion is caught.
  colourChannel: 24,
  // Both streams start at the beginning of the file (seconds).
  startTime: 0.001,
});

// The palette colours fixtures use; a probe region "shows" the nearest one.
export const PALETTE: Record<string, Rgb> = {
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  magenta: [255, 0, 255],
  yellow: [255, 255, 0],
  white: [255, 255, 255],
  black: [0, 0, 0],
};

const ffmpeg = (args: string[], options: { maxBuffer?: number } = {}) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", ...args],
    {
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024,
    },
  );

// Decodes the listed frame indices (in display order) as RGB.
export function decodeFrames(
  file: string,
  indices: number[],
  width: number,
  height: number,
): Map<number, Frame> {
  const wanted = [...new Set(indices)].sort((a, b) => a - b);
  const select = wanted.map((n) => `eq(n\\,${n})`).join("+");
  const raw = ffmpeg([
    "-i",
    file,
    "-vf",
    `select='${select}'`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  const size = width * height * 3;
  const frames = new Map<number, Frame>();
  wanted.forEach((n, i) => {
    const rgb = raw.subarray(i * size, (i + 1) * size);
    if (rgb.length === size) frames.set(n, { width, height, rgb });
  });
  return frames;
}

// Decodes a still image (a reference preview) as RGB.
export function decodeStill(
  file: string,
  width: number,
  height: number,
): Frame {
  const rgb = ffmpeg(["-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (rgb.length !== width * height * 3)
    throw new Error(`Still is not ${width}x${height}.`);
  return { width, height, rgb };
}

export function meanColour(frame: Frame, r: Region): Rgb {
  const sum = [0, 0, 0];
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * frame.width + x) * 3;
      for (let c = 0; c < 3; c++) sum[c] += frame.rgb[i + c];
    }
  const n = r.w * r.h;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

export function nearestColour(rgb: Rgb) {
  let best = "";
  let distance = Infinity;
  for (const [name, p] of Object.entries(PALETTE)) {
    const d = Math.hypot(rgb[0] - p[0], rgb[1] - p[1], rgb[2] - p[2]);
    if (d < distance) [best, distance] = [name, d];
  }
  return best;
}

const luma = (f: Frame, r: Region) => {
  const out = new Float64Array(r.w * r.h);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const i = ((r.y + y) * f.width + r.x + x) * 3;
      out[y * r.w + x] =
        0.299 * f.rgb[i] + 0.587 * f.rgb[i + 1] + 0.114 * f.rgb[i + 2];
    }
  return out;
};

// SSIM on luma over 8x8 windows every 4 pixels (the x264/FFmpeg method).
export function ssim(a: Frame, b: Frame, region?: Region): number {
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height };
  const la = luma(a, r);
  const lb = luma(b, r);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let count = 0;
  for (let y = 0; y + 8 <= r.h; y += 4)
    for (let x = 0; x + 8 <= r.w; x += 4) {
      let sa = 0,
        sb = 0,
        saa = 0,
        sbb = 0,
        sab = 0;
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          const p = la[(y + j) * r.w + x + i];
          const q = lb[(y + j) * r.w + x + i];
          sa += p;
          sb += q;
          saa += p * p;
          sbb += q * q;
          sab += p * q;
        }
      const n = 64;
      const ma = sa / n,
        mb = sb / n;
      const va = saa / n - ma * ma,
        vb = sbb / n - mb * mb,
        cov = sab / n - ma * mb;
      total +=
        ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  return count ? total / count : 1;
}

// The share of a region's pixels that differ from a background colour.
export function differingShare(frame: Frame, r: Region, background: Rgb) {
  let differing = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * frame.width + x) * 3;
      const d =
        Math.abs(frame.rgb[i] - background[0]) +
        Math.abs(frame.rgb[i + 1] - background[1]) +
        Math.abs(frame.rgb[i + 2] - background[2]);
      if (d > TOLERANCE.titleContrast) differing++;
    }
  return differing / (r.w * r.h);
}

// The tight box (padded by 4 pixels, in whole 8-pixel windows) around the
// pixels of a region that differ from its background: a title's glyphs.
export function glyphBox(frame: Frame, r: Region, background: Rgb) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -1,
    y1 = -1;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * frame.width + x) * 3;
      const d =
        Math.abs(frame.rgb[i] - background[0]) +
        Math.abs(frame.rgb[i + 1] - background[1]) +
        Math.abs(frame.rgb[i + 2] - background[2]);
      if (d > TOLERANCE.titleContrast) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  if (x1 < 0) return null;
  const x = Math.max(r.x, x0 - 4);
  const y = Math.max(r.y, y0 - 4);
  const w = Math.max(8, Math.min(r.x + r.w, x1 + 5) - x);
  const h = Math.max(8, Math.min(r.y + r.h, y1 + 5) - y);
  return { x, y, w, h };
}

// Top-level MP4 boxes in order (faststart: moov before mdat).
export function topLevelBoxes(bytes: Buffer) {
  const boxes: string[] = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8));
    if (size < 8) break;
    boxes.push(type);
    at += size;
  }
  return boxes;
}

export function probe(file: string) {
  return JSON.parse(
    execFileSync(
      mediaTools().ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { encoding: "utf8", windowsHide: true },
    ),
  );
}

// Seconds from the start of the export to its first audible sample.
export function audioOnset(file: string) {
  const pcm = ffmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "s16le",
    "-",
  ]);
  const limit = TOLERANCE.audioThreshold * 32767;
  for (let i = 0; i + 1 < pcm.length; i += 2)
    if (Math.abs(pcm.readInt16LE(i)) > limit) return i / 2 / 48000;
  return null;
}

// Every click (a burst after silence) in seconds, for drift measurement.
export function clickTimes(file: string, minGapSeconds = 0.5) {
  const pcm = ffmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "s16le",
    "-",
  ]);
  const limit = TOLERANCE.audioThreshold * 32767;
  const times: number[] = [];
  let last = -Infinity;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const t = i / 2 / 48000;
    if (Math.abs(pcm.readInt16LE(i)) > limit) {
      if (t - last >= minGapSeconds) times.push(t);
      last = t;
    }
  }
  return times;
}

export type Expectation = {
  width: number;
  height: number;
  frames: number;
  // frame -> region name -> palette colour
  colours: Record<number, Record<string, string>>;
  regions: Record<string, Region>;
  title: {
    region: Region;
    present: number[];
    absent: number[];
    // The colour beneath the title on each checked frame.
    background: Record<number, string>;
  };
  // Seconds.
  audioOnset: number;
  // Reference stills (decoded) to compare whole frames and the title region.
  reference: Map<number, Frame>;
};

// Every failed check, with its reason; an empty list passes.
export function checkExport(file: string, bytes: Buffer, e: Expectation) {
  const failures: string[] = [];
  const metrics: Record<string, number> = {};
  const info = probe(file);
  const video = info.streams.find((s: any) => s.codec_type === "video");
  const audio = info.streams.find((s: any) => s.codec_type === "audio");
  if (video?.codec_name !== "h264") failures.push("video is not H.264");
  if (audio?.codec_name !== "aac") failures.push("audio is not AAC");
  if (video?.width !== e.width || video?.height !== e.height)
    failures.push(`size ${video?.width}x${video?.height}`);
  if (video?.r_frame_rate !== "30/1")
    failures.push(`frame rate ${video?.r_frame_rate}`);
  const frames = Math.round(Number(info.format.duration) * 30);
  if (Math.abs(frames - e.frames) > TOLERANCE.durationFrames)
    failures.push(`duration ${frames} frames, expected ${e.frames}`);
  for (const s of [video, audio])
    if (s && Math.abs(Number(s.start_time)) > TOLERANCE.startTime)
      failures.push(`${s.codec_type} starts at ${s.start_time} s`);
  const boxes = topLevelBoxes(bytes);
  if (!(
    boxes.indexOf("moov") >= 0 && boxes.indexOf("moov") < boxes.indexOf("mdat")
  ))
    failures.push(`not faststart: ${boxes.join(",")}`);

  const indices = [
    ...Object.keys(e.colours).map(Number),
    ...e.title.present,
    ...e.title.absent,
    ...e.reference.keys(),
  ];
  const decoded = decodeFrames(file, indices, e.width, e.height);
  for (const [n, regions] of Object.entries(e.colours)) {
    const frame = decoded.get(Number(n));
    if (!frame) {
      failures.push(`frame ${n} missing`);
      continue;
    }
    for (const [name, colour] of Object.entries(regions)) {
      const mean = meanColour(frame, e.regions[name]);
      const seen = nearestColour(mean);
      const off = Math.max(
        ...mean.map((c, i) => Math.abs(c - PALETTE[colour][i])),
      );
      if (seen !== colour)
        failures.push(`frame ${n} ${name}: ${seen}, expected ${colour}`);
      else if (off > TOLERANCE.colourChannel)
        failures.push(
          `frame ${n} ${name}: ${colour} off by ${off.toFixed(0)} on a channel`,
        );
    }
  }
  for (const n of [...e.title.present, ...e.title.absent]) {
    const frame = decoded.get(n);
    if (!frame) {
      failures.push(`frame ${n} missing`);
      continue;
    }
    const share = differingShare(
      frame,
      e.title.region,
      PALETTE[e.title.background[n]],
    );
    const present = share >= TOLERANCE.titlePixelShare;
    if (e.title.present.includes(n) && !present)
      failures.push(`frame ${n}: title missing`);
    if (e.title.absent.includes(n) && present)
      failures.push(`frame ${n}: unexpected title`);
    const ref = e.reference.get(n);
    if (ref && e.title.present.includes(n)) {
      // Compared over the reference glyphs' own box: a whole title band is
      // mostly background, which would hide wrong or reordered glyphs.
      const box = glyphBox(ref, e.title.region, PALETTE[e.title.background[n]]);
      const s = box ? ssim(frame, ref, box) : 0;
      metrics[`title SSIM @${n}`] = Number(s.toFixed(4));
      if (s < TOLERANCE.titleSsim)
        failures.push(`frame ${n}: title region SSIM ${s.toFixed(4)}`);
    }
  }
  for (const [n, ref] of e.reference) {
    const frame = decoded.get(n);
    if (!frame) {
      failures.push(`frame ${n} missing`);
      continue;
    }
    const s = ssim(frame, ref);
    metrics[`frame SSIM @${n}`] = Number(s.toFixed(4));
    if (s < TOLERANCE.frameSsim)
      failures.push(`frame ${n}: SSIM ${s.toFixed(4)} against the reference`);
  }
  const onset = audioOnset(file);
  if (onset !== null)
    metrics["audio onset ms"] = Number((onset * 1000).toFixed(1));
  if (
    onset === null ||
    Math.abs(onset - e.audioOnset) * 1000 > TOLERANCE.audioOnsetMs
  )
    failures.push(
      `audio onset ${onset === null ? "none" : `${(onset * 1000).toFixed(1)} ms`}, expected ${(e.audioOnset * 1000).toFixed(1)} ms`,
    );
  return { failures, metrics };
}
