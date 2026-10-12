import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mediaTools } from "../core/process/workers.ts";
import { compileTitles, escapeAssText, assTime } from "../core/render/ass.ts";
import { titleFonts, missingGlyphs } from "../core/render/fonts.ts";
import { renderRevision } from "../core/render.ts";
import { ProjectStore } from "../core/store.ts";
import {
  OVERLONG_TITLE,
  TYPOGRAPHY_FIXTURES,
} from "../scripts/typography-fixtures.ts";
import { CommandError } from "../core/command/errors.ts";
import {
  libassApi,
  titleCapability,
  titlesSupported,
} from "../core/render/capability.ts";

const W = 640;
const H = 360;
const SECOND = 705_600_000;

// Renders `ass` over a black frame with only the pinned fonts available, and
// returns the grayscale pixels plus libass's log.
async function render(ass: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  await mkdir(path.join(dir, "fonts"));
  for (const font of await titleFonts())
    await writeFile(path.join(dir, "fonts", font.name), font.bytes);
  await writeFile(path.join(dir, "titles.ass"), ass);
  const out = spawnSync(
    mediaTools().ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "debug",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${W}x${H}:d=1`,
      "-vf",
      "ass=titles.ass:fontsdir=fonts,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { cwd: dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(out.status, 0, String(out.stderr).slice(-2000));
  return { pixels: out.stdout as Buffer, log: String(out.stderr) };
}
// Bounding box of bright (text) pixels.
function ink(pixels: Buffer, threshold = 200) {
  let top = H,
    bottom = -1,
    left = W,
    right = -1,
    count = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (pixels[y * W + x] >= threshold) {
        count++;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
  return { count, height: bottom - top + 1, width: right - left + 1 };
}
// A script whose single cue uses `text` verbatim (unescaped), for controls.
function raw(text: string) {
  const compiled = compileTitles(
    [{ layer: 0, startTicks: 0, endTicks: SECOND, text: "PLACEHOLDER" }],
    W,
    H,
    fontsCache!,
  ).ass;
  return compiled.replace("PLACEHOLDER", text);
}
let fontsCache: Awaited<ReturnType<typeof titleFonts>> | null = null;
const cue = (text: string) => [
  { layer: 0, startTicks: 0, endTicks: SECOND, text },
];

test("escaping keeps override blocks, escapes and line breaks literal", async () => {
  assert.equal(escapeAssText("a{b}c"), "a\\{b\\}c");
  assert.equal(escapeAssText("x\\Ny"), "x\\\u2060Ny");
  assert.equal(
    escapeAssText("one\r\ntwo\rthree\u2028four"),
    "one\\Ntwo\\Nthree\\Nfour",
  );
  assert.equal(escapeAssText("tab\there\u0000\u007f"), "tabhere");
  assert.equal(escapeAssText("\\{"), "\\\u2060\\{");
  assert.ok(!escapeAssText("a\nb\r\nc").includes("\n"), "no raw newline");
});

test("ASS times round down to the centisecond and frames stay inside their cue", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(SECOND), "0:00:01.00");
  assert.equal(assTime(3725 * SECOND + SECOND / 2), "1:02:05.50");
  // 30000/1001: frame 1 starts at 1001/30000 s = 3.336 cs → 3 cs.
  assert.equal(assTime((SECOND * 1001) / 30000), "0:00:00.03");
  assert.throws(() => assTime(-1), CommandError);
  assert.throws(() => assTime(1.5), CommandError);
});

test("the pinned fonts are verified and cover Arabic and Latin; other scripts are refused", async () => {
  fontsCache = await titleFonts();
  const [regular] = fontsCache;
  assert.deepEqual(
    missingGlyphs(
      regular.bytes,
      "مرحبًا بالعالم — لا ١٢٣ ۴۵۶ (Hello, 2026!) «اقتباس» إِنَّ؟ ٬ Ünïcödé €",
    ),
    [],
  );
  assert.deepEqual(missingGlyphs(regular.bytes, "漢字 a"), ["漢", "字"]);
  assert.throws(
    () => compileTitles(cue("Title 漢"), W, H, fontsCache!),
    (e: unknown) =>
      e instanceof CommandError &&
      e.code === "VALIDATION" &&
      /U\+6F22/.test(e.message),
  );
});

test("compiled scripts are deterministic and carry automatic base direction", async () => {
  fontsCache ??= await titleFonts();
  const a = compileTitles(cue("مرحبا Hello"), W, H, fontsCache);
  const b = compileTitles(cue("مرحبا Hello"), W, H, fontsCache);
  assert.equal(a.ass, b.ass);
  assert.equal(a.sha256, b.sha256);
  assert.match(a.ass, /^Style: Default,IBM Plex Sans Arabic,.*,-1$/m);
  assert.match(a.ass, /^PlayResX: 640$/m);
  assert.equal(a.ass.split("\nDialogue: ").length, 2, "one event line");
});

test("rendered: an injected override is shown as text, not applied", async () => {
  fontsCache ??= await titleFonts();
  const attack = "{\\1a&HFF&\\3a&HFF&\\4a&HFF&}HIDDEN";
  // Control: unescaped, the override hides every part of the title.
  const control = await render(raw(attack));
  assert.equal(ink(control.pixels).count, 0, "the override works unescaped");
  const safe = await render(compileTitles(cue(attack), W, H, fontsCache).ass);
  assert.ok(ink(safe.pixels).count > 200, "escaped text is visible");
  assert.doesNotMatch(safe.log, /not found, selecting one more font/);
});

test("rendered: a backslash-N in text does not break the line", async () => {
  fontsCache ??= await titleFonts();
  const one = ink(
    (await render(compileTitles(cue("AB"), W, H, fontsCache).ass)).pixels,
  );
  // Control: unescaped, \N starts a second line and the title grows taller.
  const two = ink((await render(raw("A\\NB"))).pixels);
  assert.ok(two.height > one.height * 1.5, "the control breaks the line");
  const safe = ink(
    (await render(compileTitles(cue("A\\NB"), W, H, fontsCache).ass)).pixels,
  );
  assert.ok(safe.height < one.height * 1.3, "escaped text stays on one line");
  assert.ok(safe.width > one.width, "and shows the backslash and N");
});

test("rendered: Arabic and mixed text use only the pinned font", async () => {
  fontsCache ??= await titleFonts();
  const { pixels, log } = await render(
    compileTitles(
      cue("مرحبًا بالعالم — لا ١٢٣ (Hello, 2026!) «اقتباس» إِنَّ"),
      W,
      H,
      fontsCache,
    ).ass,
  );
  // A full line of shaped text, not a few fallback boxes.
  const box = ink(pixels);
  assert.ok(box.width > W / 3 && box.count > 100, JSON.stringify(box));
  assert.doesNotMatch(log, /not found, selecting one more font/);
  assert.match(
    log,
    /fontselect: \(IBM Plex Sans Arabic, 400, 0\) -> IBMPlexSansArabic-Regular/,
  );
});

// Contract: Encoding -1 (automatic base direction) needs libass >= 0.17;
// the probe reads the version libass itself reports and fails closed.
test("the title capability probe finds libass 0.17 or newer", async () => {
  const { libassApi } = await titleCapability();
  assert.ok(libassApi >= 0x01700000, libassApi.toString(16));
});

test("the probe fails closed on an old, missing or unreadable libass version", () => {
  assert.equal(
    libassApi("[Parsed_ass_0] libass API version: 0x1704000"),
    0x1704000,
  );
  assert.equal(
    titlesSupported(libassApi("libass API version: 0x1704000")),
    true,
  );
  assert.equal(
    titlesSupported(libassApi("libass API version: 0x1600000")),
    false,
  );
  assert.equal(
    titlesSupported(libassApi("no ass filter in this build")),
    false,
  );
  assert.equal(titlesSupported(libassApi("libass API version: 0xzz")), false);
});

test("every reviewer fixture renders with the pinned font and stays inside the frame", async () => {
  fontsCache ??= await titleFonts();
  for (const fixture of TYPOGRAPHY_FIXTURES) {
    const { pixels, log } = await render(
      compileTitles(cue(fixture.text), W, H, fontsCache).ass,
    );
    assert.doesNotMatch(
      log,
      /not found, selecting one more font/,
      fixture.name,
    );
    assert.ok(ink(pixels).count > 100, `${fixture.name} is drawn`);
    for (let y = 0; y < H; y++)
      assert.ok(
        pixels[y * W] < 96 && pixels[y * W + W - 1] < 96,
        `${fixture.name} reaches a frame edge`,
      );
  }
});

test("an export refuses a title wider than the frame instead of clipping it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const created = await store.create("Overlong");
  const withTitle = (title: string) =>
    store.save(
      {
        ...created,
        width: 1280,
        height: 720,
        clips: [
          {
            id: crypto.randomUUID(),
            trackId: created.tracks[0].id,
            assetId: null,
            startFrame: 0,
            durationFrames: 30,
            sourceFrame: 0,
            title,
          },
        ],
      },
      created.revision,
    );
  const saved = await withTitle(OVERLONG_TITLE);
  await assert.rejects(
    renderRevision(
      store,
      saved.id,
      saved.revision,
      ["exports", "o"],
      new AbortController().signal,
      () => {},
    ),
    (e: unknown) =>
      e instanceof CommandError &&
      e.code === "VALIDATION" &&
      /wider than the frame/.test(e.message),
  );
  store.close();
});
