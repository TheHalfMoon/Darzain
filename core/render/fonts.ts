// Pinned title fonts (docs/provenance/fonts.json) and their glyph coverage.
// Titles render only with these files: their bytes are verified before use,
// and text the fonts cannot draw is refused before rendering instead of
// silently falling back to whatever the host has installed.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError } from "../command/errors.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const TITLE_FONT = Object.freeze({
  family: "IBM Plex Sans Arabic",
  files: Object.freeze([
    Object.freeze({
      file: "assets/fonts/IBMPlexSansArabic-Regular.ttf",
      weight: 400,
      sha256:
        "93ac94c4b3174176d410381b86c19891086a091c3c8da940ca65d85aa6a4f8a4",
    }),
    Object.freeze({
      file: "assets/fonts/IBMPlexSansArabic-Bold.ttf",
      weight: 700,
      sha256:
        "44f73c1db689f2aac357cae39ef439d0705bd700b7d02e8d3f0079cda5a95e5f",
    }),
  ]),
});

export type PinnedFont = { name: string; sha256: string; bytes: Buffer };

let loaded: Promise<PinnedFont[]> | null = null;
// The pinned font files, verified against their recorded hashes.
export function titleFonts(): Promise<PinnedFont[]> {
  loaded ??= Promise.all(
    TITLE_FONT.files.map(async (f) => {
      const bytes = await readFile(path.join(ROOT, f.file));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== f.sha256)
        throw new CommandError(
          "CAPABILITY_UNAVAILABLE",
          "A pinned title font does not match its recorded hash.",
        );
      return { name: path.basename(f.file), sha256, bytes };
    }),
  ).catch((e) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

// Code points the shaper handles without a glyph of their own: line breaks,
// joiners, directional marks and isolates, and the word joiner the ASS
// compiler inserts after backslashes.
const FORMAT = new Set([
  0x0a, 0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0x2060, 0x2066, 0x2067, 0x2068,
  0x2069, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0xfeff,
]);

// Characters of `text` that `font` has no glyph for (in order, unique).
export function missingGlyphs(font: Buffer, text: string): string[] {
  const covered = coverage(font);
  const missing: string[] = [];
  for (const ch of new Set(text)) {
    const code = ch.codePointAt(0)!;
    if (FORMAT.has(code)) continue;
    if (!covered(code)) missing.push(ch);
  }
  return missing;
}

const coverageCache = new WeakMap<Buffer, (code: number) => boolean>();

// Parses the font's Unicode cmap (format 12 preferred, else format 4) into a
// membership test. Only the parts needed for coverage are read.
export function coverage(font: Buffer): (code: number) => boolean {
  const cached = coverageCache.get(font);
  if (cached) return cached;
  const fail = (): never => {
    throw new CommandError(
      "CAPABILITY_UNAVAILABLE",
      "A pinned title font has an unreadable character map.",
    );
  };
  if (font.length < 12) fail();
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (at + 16 > font.length) fail();
    if (font.toString("latin1", at, at + 4) === "cmap")
      cmap = font.readUInt32BE(at + 8);
  }
  if (cmap < 0 || cmap + 4 > font.length) fail();
  const subtables = font.readUInt16BE(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < subtables; i++) {
    const at = cmap + 4 + i * 8;
    if (at + 8 > font.length) fail();
    const platform = font.readUInt16BE(at);
    const encoding = font.readUInt16BE(at + 2);
    const offset = cmap + font.readUInt32BE(at + 4);
    if (offset + 2 > font.length) fail();
    const format = font.readUInt16BE(offset);
    const unicode =
      platform === 0 || (platform === 3 && [1, 10].includes(encoding));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    else if (format === 4) format4 = offset;
  }
  let test: (code: number) => boolean;
  if (format12 >= 0) {
    const groups = font.readUInt32BE(format12 + 12);
    const ranges: [number, number, number][] = [];
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + g * 12;
      if (at + 12 > font.length) fail();
      ranges.push([
        font.readUInt32BE(at),
        font.readUInt32BE(at + 4),
        font.readUInt32BE(at + 8),
      ]);
    }
    test = (code) =>
      ranges.some(
        ([start, end, glyph]) =>
          code >= start && code <= end && glyph + (code - start) !== 0,
      );
  } else if (format4 >= 0) {
    const segX2 = font.readUInt16BE(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const offsets = deltas + segX2;
    if (offsets + segX2 > font.length) fail();
    test = (code) => {
      if (code > 0xffff) return false;
      for (let i = 0; i < segX2; i += 2) {
        const end = font.readUInt16BE(ends + i);
        if (code > end) continue;
        const start = font.readUInt16BE(starts + i);
        if (code < start) return false;
        const delta = font.readUInt16BE(deltas + i);
        const rangeOffset = font.readUInt16BE(offsets + i);
        if (rangeOffset === 0) return ((code + delta) & 0xffff) !== 0;
        const at = offsets + i + rangeOffset + (code - start) * 2;
        if (at + 2 > font.length) return false;
        const glyph = font.readUInt16BE(at);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
      return false;
    };
  } else return fail();
  coverageCache.set(font, test);
  return test;
}
