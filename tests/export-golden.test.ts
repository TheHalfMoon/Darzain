// MVP journey step 8 (docs/E2E_ACCEPTANCE.md): an export matches its golden
// intent: every edit boundary ±1 frame shows the expected source, the upper
// track covers the lower, a display-rotated source is upright, a 10-bit
// source is converted to 8-bit SDR, a 25 fps source is conformed, the
// Arabic/Latin title appears and leaves on its exact frames with the
// reference glyphs, whole frames match the reference still, audio starts
// within 20 ms, and the file is H.264/AAC, 30/1, faststart, the right
// length. Negative fixtures — the same timeline with the title dropped,
// moved or reworded, clips reordered, layers swapped, the timeline cut short
// or the audio late — must each fail the same expectation.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { preview } from "../core/render/preview.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import {
  checkExport,
  decodeFrames,
  decodeStill,
  meanColour,
  nearestColour,
  type Expectation,
} from "./fixtures/golden.ts";

const W = 640;
const H = 360;
const folders: string[] = [];
after(async () => {
  closeWorkers();
  await Promise.all(
    folders.map((f) => rm(f, { recursive: true, force: true })),
  );
});
const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );
const colourSource = (colour: string, rate = 30, seconds = 4) => [
  "-f",
  "lavfi",
  "-i",
  `color=c=${colour}:s=${W}x${H}:r=${rate}:d=${seconds}`,
];

// Regions: the frame's top band (clear of the title), the left and right
// quarters of that band (for the rotated source), and the title band.
const regions = {
  top: { x: 280, y: 20, w: 80, h: 60 },
  left: { x: 60, y: 20, w: 120, h: 60 },
  right: { x: 460, y: 20, w: 120, h: 60 },
};
const titleRegion = { x: 20, y: 250, w: 600, h: 100 };
const TITLE = "مرحبا · Hello ١٢٣";

type Variant = {
  // Assets by name -> clip placement.
  order?: ["red", "green"] | ["green", "red"];
  magentaTrack?: "upper" | "under";
  title?: { text: string; start: number } | null;
  lastClipFrames?: number;
  clickFrame?: number;
};

async function build() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-golden-"));
  folders.push(root);
  const media = path.join(root, "media");
  const files: Record<string, string> = {};
  const make = (name: string, args: string[]) => {
    const file = path.join(root, name);
    ffmpeg([...args, file]);
    files[name] = file;
  };
  await import("node:fs/promises").then((fs) => fs.mkdir(media));
  make("red.mp4", [
    ...colourSource("red"),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
  ]);
  make("green.mp4", [
    ...colourSource("green"),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
  ]);
  // A 25 fps source, conformed to the 30 fps timeline.
  make("blue-25.mp4", [
    ...colourSource("blue", 25),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
  ]);
  make("magenta.mp4", [
    ...colourSource("magenta", 30, 2),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
  ]);
  // 10-bit HEVC, converted to the 8-bit SDR profile.
  make("yellow-10bit.mp4", [
    ...colourSource("yellow"),
    "-pix_fmt",
    "yuv420p10le",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-tag:v",
    "hvc1",
  ]);
  // A portrait source (white top half, black bottom) whose display matrix
  // turns it 90° counter-clockwise: upright, white is on the left.
  const portrait = path.join(root, "portrait-raw.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${H}x${W}:r=30:d=4,drawbox=x=0:y=0:w=${H}:h=${W / 2}:color=white:t=fill`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    portrait,
  ]);
  make("rotated.mp4", [
    "-display_rotation",
    "90",
    "-i",
    portrait,
    "-c",
    "copy",
  ]);
  // 4 s of silence with a 10 ms 1 kHz burst at 0.5 s.
  make("click.wav", [
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(between(t,0.5,0.51),0.8*sin(2*PI*1000*t),0)':s=48000:d=4",
  ]);

  const store = new ProjectStore(path.join(root, "workspace"));
  await store.initialize();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  return { root, files, store, supervisor };
}

async function exportVariant(
  ctx: Awaited<ReturnType<typeof build>>,
  name: string,
  v: Variant,
) {
  const { store, supervisor, files } = ctx;
  const created = await store.create(name);
  const assets: Record<string, string> = {};
  for (const file of Object.keys(files)) {
    const imported = await store.importAsset(
      created.id,
      file,
      await readFile(files[file]),
    );
    assets[file] = imported.asset.id;
  }
  const head = await store.load(created.id);
  const id = () => crypto.randomUUID();
  const track = (name: string, kind: "video" | "audio") => ({
    id: id(),
    name,
    kind,
    muted: false,
    locked: false,
  });
  // Lower tracks first: later video tracks draw on top.
  const under = track("Under", "video");
  const main = track("Main", "video");
  const upper = track("Upper", "video");
  const titles = track("Titles", "video");
  const sound = track("Sound", "audio");
  const clip = (
    trackId: string,
    asset: string | null,
    startFrame: number,
    durationFrames: number,
    title: string | null = null,
  ) => ({
    id: id(),
    trackId,
    assetId: asset ? assets[asset] : null,
    startFrame,
    durationFrames,
    sourceFrame: 0,
    title,
  });
  const [first, second] = (v.order ?? ["red", "green"]).map((c) => `${c}.mp4`);
  const clips = [
    clip(main.id, first, 0, 60),
    clip(main.id, second, 60, 60),
    clip(main.id, "blue-25.mp4", 120, 60),
    clip(main.id, "rotated.mp4", 180, 60),
    clip(main.id, "yellow-10bit.mp4", 240, v.lastClipFrames ?? 60),
    clip(
      (v.magentaTrack ?? "upper") === "upper" ? upper.id : under.id,
      "magenta.mp4",
      90,
      15,
    ),
    clip(sound.id, "click.wav", v.clickFrame ?? 45, 90),
  ];
  const title = v.title === undefined ? { text: TITLE, start: 30 } : v.title;
  if (title)
    clips.push(clip(titles.id, null, title.start, 75 - 30, title.text));
  const saved = await store.save(
    {
      ...head,
      width: W,
      height: H,
      tracks: [under, main, upper, titles, sound],
      clips,
    },
    head.revision,
  );
  const job = await supervisor.submit(created.id, `golden-${name}`);
  let state = supervisor.status(job.id);
  for (
    let i = 0;
    i < 1200 && !["COMPLETED", "FAILED", "CANCELLED"].includes(state.state);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 100));
    state = supervisor.status(job.id);
  }
  assert.equal(state.state, "COMPLETED", state.error ?? "");
  const file = await store.file(created.id, state.artifact!);
  return { file, bytes: await readFile(file), project: saved };
}

test(
  "an export matches its golden intent, and every negative fixture fails it",
  { timeout: 600_000 },
  async () => {
    const ctx = await build();
    try {
      // The rotated source's upright picture, as FFmpeg itself displays it
      // (an oracle independent of the renderer): white on the left.
      const upright = decodeFrames(ctx.files["rotated.mp4"], [0], W, H).get(0)!;
      assert.equal(nearestColour(meanColour(upright, regions.left)), "white");
      assert.equal(nearestColour(meanColour(upright, regions.right)), "black");

      const golden = await exportVariant(ctx, "golden", {});
      // Reference stills of the golden project at the boundaries, the title
      // cue edges and evenly spaced frames (≥ 12).
      const referenceFrames = [
        0, 15, 29, 30, 31, 45, 59, 60, 61, 74, 75, 89, 90, 104, 105, 119, 120,
        121, 150, 179, 180, 181, 210, 239, 240, 241, 270, 299,
      ];
      const reference = new Map<number, ReturnType<typeof decodeStill>>();
      for (const n of referenceFrames) {
        const still = await preview(
          ctx.store,
          golden.project.id,
          golden.project.revision,
          "frame",
          n,
        );
        reference.set(n, decodeStill(still.file, W, H));
      }
      const top = (c: string) => ({ top: c });
      const expectation: Expectation = {
        width: W,
        height: H,
        frames: 300,
        regions,
        colours: {
          0: top("red"),
          29: top("red"),
          59: top("red"),
          60: top("green"),
          61: top("green"),
          89: top("green"),
          90: top("magenta"),
          104: top("magenta"),
          105: top("green"),
          119: top("green"),
          120: top("blue"),
          121: top("blue"),
          179: top("blue"),
          180: { left: "white", right: "black" },
          181: { left: "white", right: "black" },
          239: { left: "white", right: "black" },
          240: top("yellow"),
          241: top("yellow"),
          299: top("yellow"),
        },
        title: {
          region: titleRegion,
          present: [30, 31, 74],
          absent: [29, 75],
          background: {
            29: "red",
            30: "red",
            31: "red",
            74: "green",
            75: "green",
          },
        },
        // The click is 0.5 s into a clip placed at frame 45 (1.5 s).
        audioOnset: 2,
        reference,
      };
      const passed = checkExport(golden.file, golden.bytes, expectation);
      assert.deepEqual(passed.failures, [], passed.failures.join("\n"));

      const negatives: [string, Variant, RegExp][] = [
        ["title dropped", { title: null }, /title missing/],
        [
          "title one frame late",
          { title: { text: TITLE, start: 31 } },
          /frame 30: title missing/,
        ],
        [
          "title reworded",
          { title: { text: "Hello · مرحبا ١٢٣", start: 30 } },
          /title region SSIM/,
        ],
        [
          "clips reordered",
          { order: ["green", "red"] },
          /frame 0 top: green, expected red/,
        ],
        [
          "layers swapped",
          { magentaTrack: "under" },
          /frame 90 top: green, expected magenta/,
        ],
        ["cut short", { lastClipFrames: 45 }, /duration 285 frames/],
        ["audio one frame late", { clickFrame: 46 }, /audio onset 20[34]\d/],
      ];
      for (const [name, variant, reason] of negatives) {
        const out = await exportVariant(
          ctx,
          name.replaceAll(" ", "-"),
          variant,
        );
        const { failures } = checkExport(out.file, out.bytes, expectation);
        assert.ok(
          failures.some((f) => reason.test(f)),
          `${name}: expected ${reason}, got ${JSON.stringify(failures)}`,
        );
      }
    } finally {
      await ctx.supervisor.close();
      ctx.store.close();
    }
  },
);
