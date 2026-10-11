// Timeline time is integer flicks: 705,600,000 per second, exact for 24/25/30/
// 50/60/120 fps, the NTSC 1001 rates and 8–96 kHz sample positions. All
// conversion intermediates use BigInt; results are checked against the
// safe-integer range before they are serialized. Floating seconds are never
// accumulated.
import { z } from "zod";

export const FLICKS_PER_SECOND = 705_600_000;
const F = BigInt(FLICKS_PER_SECOND);

export type Rounding = "exact" | "floor" | "ceil" | "nearest";
export type Rational = { num: number; den: number };

export const RationalSchema = z
  .object({
    num: z.number().int().positive().max(1_000_000_000),
    den: z.number().int().positive().max(1_000_000_000),
  })
  .strict()
  .refine((r) => gcd(BigInt(r.num), BigInt(r.den)) === 1n, {
    message: "Rational must be reduced.",
  });

// A serialized tick count: a non-negative safe integer.
export const Ticks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function rational(num: number, den: number): Rational {
  if (
    !Number.isSafeInteger(num) ||
    !Number.isSafeInteger(den) ||
    num <= 0 ||
    den <= 0
  )
    throw new RangeError("Rational parts must be positive safe integers.");
  const g = gcd(BigInt(num), BigInt(den));
  return { num: Number(BigInt(num) / g), den: Number(BigInt(den) / g) };
}

// Signed division with an explicit rounding mode.
export function divide(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (d === 0n) throw new RangeError("Division by zero.");
  if (d < 0n) [n, d] = [-n, -d];
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  if (rounding === "exact")
    throw new RangeError("Time value is not exactly representable.");
  const floor = n < 0n ? q - 1n : q;
  if (rounding === "floor") return floor;
  if (rounding === "ceil") return floor + 1n;
  // Nearest, ties away from zero.
  const twice = 2n * (r < 0n ? -r : r);
  if (twice === d) return n < 0n ? floor : floor + 1n;
  return twice > d
    ? n < 0n
      ? floor
      : floor + 1n
    : n < 0n
      ? floor + 1n
      : floor;
}

export function toSafe(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError("Time value exceeds the safe-integer range.");
  return Number(value);
}

const big = (value: number, label: string) => {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be a safe integer.`);
  return BigInt(value);
};

// frame index at rate fps → ticks: frame * F * den / num
export function framesToTicks(
  frames: number,
  fps: Rational,
  rounding: Rounding = "exact",
) {
  return toSafe(
    divide(
      big(frames, "Frames") * F * big(fps.den, "fps.den"),
      big(fps.num, "fps.num"),
      rounding,
    ),
  );
}

// ticks → frame index at rate fps: ticks * num / (F * den)
export function ticksToFrames(
  ticks: number,
  fps: Rational,
  rounding: Rounding = "exact",
) {
  return toSafe(
    divide(
      big(ticks, "Ticks") * big(fps.num, "fps.num"),
      F * big(fps.den, "fps.den"),
      rounding,
    ),
  );
}

// stream PTS in timebase units → ticks: pts * tb.num * F / tb.den
export function ptsToTicks(
  pts: number,
  timebase: Rational,
  rounding: Rounding = "exact",
) {
  return toSafe(
    divide(
      big(pts, "PTS") * big(timebase.num, "timebase.num") * F,
      big(timebase.den, "timebase.den"),
      rounding,
    ),
  );
}

export function ticksToPts(
  ticks: number,
  timebase: Rational,
  rounding: Rounding = "exact",
) {
  return toSafe(
    divide(
      big(ticks, "Ticks") * big(timebase.den, "timebase.den"),
      big(timebase.num, "timebase.num") * F,
      rounding,
    ),
  );
}

// Checked addition of serialized tick values.
export function addTicks(a: number, b: number) {
  return toSafe(big(a, "Ticks") + big(b, "Ticks"));
}
