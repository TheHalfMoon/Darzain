// T7 typography qualification: renders the Arabic/Latin fixtures through the
// real export path (project → render plan → libass with the pinned fonts →
// MP4) on a landscape and a portrait frame, extracts one frame per title,
// and writes the frames and a receipt under docs/evidence/qualification/.
// The frames are for a human Arabic reviewer; the receipt records that
// review as pending until one signs off. It runs only on a clean tree, so
// the recorded commit is the code that produced the evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { renderRevision } from "../core/render.ts";
import { titleCapability } from "../core/render/capability.ts";
import { CommandError } from "../core/command/errors.ts";
import { mediaTools, closeWorkers } from "../core/process/workers.ts";
import { OVERLONG_TITLE, TYPOGRAPHY_FIXTURES } from "./typography-fixtures.ts";

const OUT = "docs/evidence/qualification/typography";
const RECEIPT = "docs/evidence/qualification/t7-typography.json";
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git(
  "status",
  "--porcelain",
  "--",
  ".",
  `:!${OUT}`,
  `:!${RECEIPT}`,
);
if (dirty)
  throw new Error(`Commit or stash changes before qualifying:\n${dirty}`);

const root = await mkdtemp(path.join(tmpdir(), "yamakan-typography-"));
try {
  const store = new ProjectStore(root);
  await store.initialize();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const titled = async (width: number, height: number, titles: string[]) => {
    const created = await store.create(`Typography ${width}x${height}`);
    return store.save(
      {
        ...created,
        width,
        height,
        clips: titles.map((title, i) => ({
          id: crypto.randomUUID(),
          trackId: created.tracks[0].id,
          assetId: null,
          startFrame: i * 30,
          durationFrames: 30,
          sourceFrame: 0,
          title,
        })),
      },
      created.revision,
    );
  };
  const renders = [];
  // The long word fits the landscape frame but not the narrow portrait
  // one, where it is one of the refused clipping cases below.
  for (const [label, width, height] of [
    ["landscape", 1280, 720],
    ["portrait", 608, 1080],
  ] as const) {
    const fixtures = TYPOGRAPHY_FIXTURES.filter(
      (f) => label === "landscape" || f.name !== "long-word",
    );
    const saved = await titled(
      width,
      height,
      fixtures.map((f) => f.text),
    );
    const { output, plan, receipt } = await renderRevision(
      store,
      saved.id,
      saved.revision,
      ["exports", label],
      new AbortController().signal,
      () => {},
    );
    const frames = [];
    for (const [i, f] of fixtures.entries()) {
      const file = path.join(
        OUT,
        `${label}-${String(i + 1).padStart(2, "0")}-${f.name}.png`,
      );
      execFileSync(
        mediaTools().ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          String(i + 0.5),
          "-i",
          output,
          "-frames:v",
          "1",
          file,
        ],
        { windowsHide: true },
      );
      frames.push({
        name: f.name,
        text: f.text,
        atSeconds: i + 0.5,
        file: file.replaceAll("\\", "/"),
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
    }
    renders.push({
      label,
      width,
      height,
      planHash: plan.planHash,
      assSha256: plan.titles!.sha256,
      fonts: plan.fonts,
      output: receipt,
      frames,
    });
  }
  // Clipping: a title wider than the frame is refused before rendering,
  // by the fit check and not by any other failure.
  const clipping = [];
  for (const [label, width, height, text] of [
    ["landscape", 1280, 720, OVERLONG_TITLE],
    [
      "portrait",
      608,
      1080,
      TYPOGRAPHY_FIXTURES.find((f) => f.name === "long-word")!.text,
    ],
  ] as const) {
    const saved = await titled(width, height, [text]);
    const refusal = await renderRevision(
      store,
      saved.id,
      saved.revision,
      ["exports", `overlong-${label}`],
      new AbortController().signal,
      () => {},
    ).then(
      () => null,
      (e: unknown) => e,
    );
    if (
      !(refusal instanceof CommandError) ||
      refusal.code !== "VALIDATION" ||
      !/does not fit the frame/.test(refusal.message)
    )
      throw new Error("A title wider than its frame was not refused.", {
        cause: refusal,
      });
    clipping.push({
      label,
      width,
      height,
      text,
      outcome: "refused",
      message: refusal.message,
    });
  }
  const report = {
    qualification: "t7-typography",
    date: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    platform: `${process.platform}-${process.arch}`,
    ffmpeg: execFileSync(mediaTools().ffmpeg, ["-hide_banner", "-version"], {
      encoding: "utf8",
      windowsHide: true,
    }).split("\n")[0],
    libassApi: `0x${(await titleCapability()).libassApi.toString(16)}`,
    renders,
    clipping,
    automatedChecks:
      "tests/typography.test.ts: no system-font fallback, escaping against controls, frame-exact cue boundaries, and the margin-band fit check for every fixture",
    arabicReview: {
      status: "pending",
      reviewer: "Founder or a delegated Arabic reviewer",
      instructions:
        "Check shaping, joining, lam-alef ligatures, tatweel, diacritic placement, punctuation mirroring and placement, digit shapes and separators, isolate ordering, line order of mixed lines, wrap points, and that nothing is clipped, on both frame shapes.",
    },
  };
  await writeFile(RECEIPT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { commit: report.commit, frames: renders.map((r) => r.frames.length) },
      null,
      2,
    ),
  );
  store.close();
} finally {
  closeWorkers();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
