// T7 typography qualification: renders the Arabic/Latin fixtures through the
// real export path (project → render plan → libass with the pinned fonts →
// MP4), extracts one frame per title, and writes the frames and a receipt
// under docs/evidence/qualification/. The frames are for a human Arabic
// reviewer; the receipt records that review as pending until one signs off.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { renderRevision } from "../core/render.ts";
import { titleCapability } from "../core/render/capability.ts";
import { mediaTools, closeWorkers } from "../core/process/workers.ts";
import { OVERLONG_TITLE, TYPOGRAPHY_FIXTURES } from "./typography-fixtures.ts";

const OUT = "docs/evidence/qualification/typography";
const SECONDS_PER_TITLE = 1;

const root = await mkdtemp(path.join(tmpdir(), "yamakan-typography-"));
try {
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Typography qualification");
  const saved = await store.save(
    {
      ...created,
      width: 1280,
      height: 720,
      clips: TYPOGRAPHY_FIXTURES.map((f, i) => ({
        id: crypto.randomUUID(),
        trackId: created.tracks[0].id,
        assetId: null,
        startFrame: i * 30 * SECONDS_PER_TITLE,
        durationFrames: 30 * SECONDS_PER_TITLE,
        sourceFrame: 0,
        title: f.text,
      })),
    },
    created.revision,
  );
  const { output, plan, receipt } = await renderRevision(
    store,
    saved.id,
    saved.revision,
    ["exports", "typography"],
    new AbortController().signal,
    () => {},
  );
  await mkdir(OUT, { recursive: true });
  const frames = [];
  for (const [i, f] of TYPOGRAPHY_FIXTURES.entries()) {
    const at = (i + 0.5) * SECONDS_PER_TITLE;
    const file = path.join(
      OUT,
      `${String(i + 1).padStart(2, "0")}-${f.name}.png`,
    );
    execFileSync(
      mediaTools().ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(at),
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
      atSeconds: at,
      file: file.replaceAll("\\", "/"),
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
  }
  // Clipping: a title wider than the frame is refused before rendering.
  const overlong = await store.save(
    {
      ...saved,
      clips: [
        {
          id: crypto.randomUUID(),
          trackId: saved.tracks[0].id,
          assetId: null,
          startFrame: 0,
          durationFrames: 30,
          sourceFrame: 0,
          title: OVERLONG_TITLE,
        },
      ],
    },
    saved.revision,
  );
  const clipping = await renderRevision(
    store,
    overlong.id,
    overlong.revision,
    ["exports", "typography-overlong"],
    new AbortController().signal,
    () => {},
  ).then(
    () => ({ outcome: "rendered (unexpected)" }),
    (e: Error) => ({ outcome: "refused", message: e.message }),
  );
  if (clipping.outcome !== "refused")
    throw new Error("An overlong title was rendered instead of refused.");
  const ffmpeg = execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-version"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  ).split("\n")[0];
  const report = {
    qualification: "t7-typography",
    date: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    platform: `${process.platform}-${process.arch}`,
    ffmpeg,
    libassApi: `0x${(await titleCapability()).libassApi.toString(16)}`,
    planHash: plan.planHash,
    assSha256: plan.titles!.sha256,
    fonts: plan.fonts,
    output: receipt,
    frames,
    clipping: { text: OVERLONG_TITLE, ...clipping },
    automatedChecks:
      "tests/typography.test.ts: no system-font fallback, escaping, line wrap and edge clearance for these fixtures",
    arabicReview: {
      status: "pending",
      reviewer: "Founder or a delegated Arabic reviewer",
      instructions:
        "Check shaping, joining, lam-alef ligatures, diacritic placement, punctuation mirroring and placement, digit shapes, isolate ordering, line order of mixed lines, wrap points and that nothing is clipped.",
    },
  };
  await writeFile(
    "docs/evidence/qualification/t7-typography.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ planHash: plan.planHash, frames: frames.length }, null, 2),
  );
  store.close();
} finally {
  closeWorkers();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
