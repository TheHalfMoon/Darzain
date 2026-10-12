import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mediaTools } from "../core/process/workers.ts";
import { compileTitles, escapeAssText, assTime } from "../core/render/ass.ts";
import { titleFonts, missingGlyphs } from "../core/render/fonts.ts";
import { overflows, renderRevision } from "../core/render.ts";
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

// Tests remove their own folders; these catch what a failed test leaves,
// after its store closes (Windows cannot delete an open database).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});

// Renders `ass` over a black frame with only the pinned fonts available, and
// returns the grayscale pixels plus libass's log.
async function render(ass: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  bases.push(dir);
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
  await rm(dir, { recursive: true, force: true });
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

test("ASS times sit 1 ms before their instant, rounded down to the centisecond", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(SECOND), "0:00:00.99");
  assert.equal(assTime(3725 * SECOND + SECOND / 2), "1:02:05.49");
  // Frame 111 at 30 fps is 3.7 s, which FFmpeg can hand libass as 3699 ms.
  assert.equal(assTime(111 * (SECOND / 30)), "0:00:03.69");
  // 30000/1001: frame 1 starts at 33.366 ms → 32 ms → 3 cs.
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
    assert.equal(overflows(pixels, W, H), false, `${fixture.name} overflows`);
  }
});

test("an export refuses a title wider than the frame instead of clipping it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
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
      /does not fit the frame/.test(e.message),
  );
  store.close();
  await rm(root, { recursive: true, force: true });
});

// Renders `ass` over a 30 fps black clip and returns frames `from`..`to`
// (inclusive) as grayscale pixels.
async function frames(ass: string, from: number, to: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  bases.push(dir);
  try {
    await mkdir(path.join(dir, "fonts"));
    for (const font of await titleFonts())
      await writeFile(path.join(dir, "fonts", font.name), font.bytes);
    await writeFile(path.join(dir, "titles.ass"), ass);
    const out = spawnSync(
      mediaTools().ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${W}x${H}:r=30:d=${(to + 1) / 30}`,
        "-vf",
        `ass=titles.ass:fontsdir=fonts,select='between(n\\,${from}\\,${to})',format=gray`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
      ],
      { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(out.status, 0, String(out.stderr));
    const buf = out.stdout as Buffer;
    return Array.from({ length: to - from + 1 }, (_, i) =>
      buf.subarray(i * W * H, (i + 1) * W * H),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("rendered: back-to-back titles change on the exact frame, including frame 111", async () => {
  fontsCache ??= await titleFonts();
  const frame = SECOND / 30;
  // A on frames 106–110, B on 111–115: a boundary FFmpeg reports 1 ms early.
  const ass = compileTitles(
    [
      { layer: 0, startTicks: 106 * frame, endTicks: 111 * frame, text: "A" },
      {
        layer: 0,
        startTicks: 111 * frame,
        endTicks: 116 * frame,
        text: "WWWWWW",
      },
    ],
    W,
    H,
    fontsCache,
  ).ass;
  const [f105, f106, f110, f111, f115, f116] = (
    await frames(ass, 105, 116)
  ).filter((_, i) => [0, 1, 5, 6, 10, 11].includes(i));
  assert.equal(ink(f105).count, 0, "nothing before A");
  const a = ink(f106).width;
  assert.ok(a > 0 && ink(f110).width === a, "A on its frames");
  const b = ink(f111).width;
  assert.ok(b > a * 3, "frame 111 shows B alone");
  assert.equal(ink(f115).width, b);
  assert.equal(ink(f116).count, 0, "nothing after B");
});

test("titles that overflow by glyph gaps or by line count are refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  try {
    await store.initialize();
    const created = await store.create("Overflow");
    let revision = created.revision;
    for (const title of ["i".repeat(400), "a\n".repeat(60)]) {
      const saved = await store.save(
        {
          ...created,
          revision,
          width: 640,
          height: 360,
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
        revision,
      );
      revision = saved.revision;
      await assert.rejects(
        renderRevision(
          store,
          saved.id,
          saved.revision,
          ["exports", `o${revision}`],
          new AbortController().signal,
          () => {},
        ),
        /does not fit the frame/,
        JSON.stringify(title.slice(0, 8)),
      );
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one large still used by two clips renders (each clip reads its own input)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-type-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  try {
    await store.initialize();
    const created = await store.create("Shared still");
    const png = path.join(root, "big.png");
    spawnSync(
      mediaTools().ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080",
        "-frames:v",
        "1",
        png,
      ],
      { windowsHide: true },
    );
    const { asset, project } = await store.importAsset(
      created.id,
      "big.png",
      await readFile(png),
    );
    const clip = (startFrame: number) => ({
      id: crypto.randomUUID(),
      trackId: project.tracks[0].id,
      assetId: asset.id,
      startFrame,
      durationFrames: 300,
      sourceFrame: 0,
      title: null,
    });
    const saved = await store.save(
      { ...project, width: 640, height: 360, clips: [clip(0), clip(300)] },
      project.revision,
    );
    const { receipt } = await renderRevision(
      store,
      saved.id,
      saved.revision,
      ["exports", "shared"],
      new AbortController().signal,
      () => {},
    );
    assert.equal(receipt.durationFrames, 600);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
