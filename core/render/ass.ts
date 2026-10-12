// Title compiler (plan T7, contract "Canonical render plan"): project titles
// become one ASS script rendered by libass. Project text is always escaped
// plain text: it can never open an override block, form an ASS escape, or
// end its Dialogue line, and it never becomes part of a filtergraph.
// The output is deterministic, so its bytes and hash belong to the plan.
import { createHash } from "node:crypto";
import { FLICKS_PER_SECOND } from "../time.ts";
import { CommandError } from "../command/errors.ts";
import { TITLE_FONT, missingGlyphs } from "./fonts.ts";
import type { PinnedFont } from "./fonts.ts";

export const ASS_COMPILER_VERSION = "yamakan.ass/1";

export type TitleCue = {
  // Order on screen: a later layer draws above an earlier one.
  layer: number;
  startTicks: number;
  endTicks: number;
  text: string;
};

const WORD_JOINER = "\u2060";
// CR, CRLF and the Unicode line and paragraph separators.
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

// Escapes plain text for an ASS Dialogue Text field:
// - control characters other than line breaks are dropped;
// - every backslash is followed by a word joiner, so no "\N", "\h", "\n"
//   or "\{" escape can be formed from project text;
// - braces are escaped ("\{", "\}") and display literally;
// - line breaks (CR, LF, CRLF, U+2028, U+2029) become "\N".
export function escapeAssText(text: string): string {
  return (
    text
      .replace(LINE_BREAKS, "\n")
      // Control characters are dropped on purpose.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
      .replace(/\\/g, `\\${WORD_JOINER}`)
      .replace(/[{}]/g, (brace) => `\\${brace}`)
      .replace(/\n/g, "\\N")
  );
}

// ASS time (h:mm:ss.cc) from flick ticks, rounded down to the centisecond.
// A cue that starts at frame k is visible on frame k and not on frame k-1
// for any frame rate whose frame lasts longer than a centisecond.
export function assTime(ticks: number): string {
  if (!Number.isSafeInteger(ticks) || ticks < 0)
    throw new CommandError("VALIDATION", "Title time is out of range.");
  const cs = (BigInt(ticks) * 100n) / BigInt(FLICKS_PER_SECOND);
  const h = cs / 360000n;
  const m = (cs / 6000n) % 60n;
  const s = (cs / 100n) % 60n;
  const c = cs % 100n;
  const two = (n: bigint) => n.toString().padStart(2, "0");
  return `${h}:${two(m)}:${two(s)}.${two(c)}`;
}

// The title style, sized from the output height like the previous drawtext
// titles: white text on a translucent box, bottom-centred, with automatic
// paragraph direction (Encoding -1) so Arabic and Latin lines both read
// correctly.
function style(width: number, height: number) {
  const size = Math.round(height / 15);
  const margin = Math.round(height / 27);
  return [
    "Default",
    TITLE_FONT.family,
    size,
    "&H00FFFFFF",
    "&H00FFFFFF",
    "&H5A000000",
    "&H5A000000",
    0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    3,
    Math.max(2, Math.round(size / 5)),
    0,
    2,
    Math.round(width / 20),
    Math.round(width / 20),
    margin,
    -1,
  ].join(",");
}

export type CompiledTitles = { ass: string; sha256: string };

// Compiles cues for an output of `width`×`height`. Text the pinned fonts
// cannot draw is refused here, before any render starts.
export function compileTitles(
  cues: TitleCue[],
  width: number,
  height: number,
  fonts: PinnedFont[],
): CompiledTitles {
  const regular = fonts[0];
  for (const cue of cues) {
    if (cue.endTicks <= cue.startTicks)
      throw new CommandError("VALIDATION", "Title duration must be positive.");
    const missing = missingGlyphs(regular.bytes, cue.text);
    if (missing.length)
      throw new CommandError(
        "VALIDATION",
        `Title text contains characters the title font cannot display: ${missing
          .slice(0, 8)
          .map(
            (c) =>
              `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
          )
          .join(", ")}.`,
      );
  }
  const events = [...cues]
    .sort((a, b) => a.layer - b.layer || a.startTicks - b.startTicks)
    .map(
      (cue) =>
        `Dialogue: ${cue.layer},${assTime(cue.startTicks)},${assTime(cue.endTicks)},Default,,0,0,0,,${escapeAssText(cue.text)}`,
    );
  const ass = [
    "[Script Info]",
    `; ${ASS_COMPILER_VERSION}`,
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style(width, height)}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
  return { ass, sha256: createHash("sha256").update(ass).digest("hex") };
}
