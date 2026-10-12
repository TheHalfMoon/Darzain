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

type Metrics = {
  glyph: (code: number) => number;
  advance: (glyph: number) => number;
  unitsPerEm: number;
};
const metricsCache = new WeakMap<Buffer, Metrics>();

const unreadable = (): never => {
  throw new CommandError(
    "CAPABILITY_UNAVAILABLE",
    "A pinned title font has an unreadable table.",
  );
};

// Offsets of the font's tables by tag.
function tables(font: Buffer) {
  if (font.length < 12) unreadable();
  const count = font.readUInt16BE(4);
  const found = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > font.length) unreadable();
    found.set(font.toString("latin1", at, at + 4), font.readUInt32BE(at + 8));
  }
  return found;
}

// Parses what title fitting needs: the Unicode cmap (format 12 preferred,
// else format 4) as code point → glyph id (0 when missing), and horizontal
// advances from hmtx in font units.
export function metrics(font: Buffer): Metrics {
  const cached = metricsCache.get(font);
  if (cached) return cached;
  const t = tables(font);
  const cmap = t.get("cmap") ?? unreadable();
  const head = t.get("head") ?? unreadable();
  const hhea = t.get("hhea") ?? unreadable();
  const hmtx = t.get("hmtx") ?? unreadable();
  if (cmap + 4 > font.length || head + 20 > font.length) unreadable();
  if (hhea + 36 > font.length) unreadable();
  const subtables = font.readUInt16BE(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < subtables; i++) {
    const at = cmap + 4 + i * 8;
    if (at + 8 > font.length) unreadable();
    const platform = font.readUInt16BE(at);
    const encoding = font.readUInt16BE(at + 2);
    const offset = cmap + font.readUInt32BE(at + 4);
    if (offset + 2 > font.length) unreadable();
    const format = font.readUInt16BE(offset);
    const unicode =
      platform === 0 || (platform === 3 && [1, 10].includes(encoding));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    else if (format === 4) format4 = offset;
  }
  let glyph: (code: number) => number;
  if (format12 >= 0) {
    const groups = font.readUInt32BE(format12 + 12);
    const ranges: [number, number, number][] = [];
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + g * 12;
      if (at + 12 > font.length) unreadable();
      ranges.push([
        font.readUInt32BE(at),
        font.readUInt32BE(at + 4),
        font.readUInt32BE(at + 8),
      ]);
    }
    glyph = (code) => {
      const range = ranges.find(([start, end]) => code >= start && code <= end);
      return range ? range[2] + (code - range[0]) : 0;
    };
  } else if (format4 >= 0) {
    const segX2 = font.readUInt16BE(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const offsets = deltas + segX2;
    if (offsets + segX2 > font.length) unreadable();
    glyph = (code) => {
      if (code > 0xffff) return 0;
      for (let i = 0; i < segX2; i += 2) {
        if (code > font.readUInt16BE(ends + i)) continue;
        const start = font.readUInt16BE(starts + i);
        if (code < start) return 0;
        const delta = font.readUInt16BE(deltas + i);
        const rangeOffset = font.readUInt16BE(offsets + i);
        if (rangeOffset === 0) return (code + delta) & 0xffff;
        const at = offsets + i + rangeOffset + (code - start) * 2;
        if (at + 2 > font.length) return 0;
        const id = font.readUInt16BE(at);
        return id === 0 ? 0 : (id + delta) & 0xffff;
      }
      return 0;
    };
  } else return unreadable();
  const unitsPerEm = font.readUInt16BE(head + 18);
  const longMetrics = font.readUInt16BE(hhea + 34);
  if (!unitsPerEm || !longMetrics || hmtx + longMetrics * 4 > font.length)
    unreadable();
  const advance = (id: number) =>
    font.readUInt16BE(hmtx + Math.min(id, longMetrics - 1) * 4);
  const parsed = { glyph, advance, unitsPerEm };
  metricsCache.set(font, parsed);
  return parsed;
}

// Whether the font has a glyph for a code point.
export function coverage(font: Buffer): (code: number) => boolean {
  const { glyph } = metrics(font);
  return (code) => glyph(code) !== 0;
}
