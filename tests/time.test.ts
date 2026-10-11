import test from "node:test";
import assert from "node:assert/strict";
import {
  FLICKS_PER_SECOND,
  RationalSchema,
  addTicks,
  divide,
  framesToTicks,
  ptsToTicks,
  rational,
  ticksToFrames,
  ticksToPts,
} from "../core/time.ts";

// Deterministic pseudo-random generator so property checks are reproducible.
function lcg(seed: number) {
  let s = BigInt(seed);
  return (max: number) => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number((s >> 11n) % BigInt(max));
  };
}

test("common frame and sample rates are exact in flicks", () => {
  for (const [num, den] of [
    [24, 1],
    [25, 1],
    [30, 1],
    [50, 1],
    [60, 1],
    [120, 1],
    [24000, 1001],
    [30000, 1001],
    [60000, 1001],
    [8000, 1],
    [44100, 1],
    [48000, 1],
    [96000, 1],
  ])
    assert.equal(
      (FLICKS_PER_SECOND * den) % num,
      0,
      `${num}/${den} must be exact`,
    );
  assert.equal(framesToTicks(1, rational(30, 1)), 23_520_000);
  assert.equal(framesToTicks(1, rational(48000, 1)), 14_700);
});

test("rounding modes are explicit and signed", () => {
  assert.equal(divide(7n, 2n, "floor"), 3n);
  assert.equal(divide(7n, 2n, "ceil"), 4n);
  assert.equal(divide(7n, 2n, "nearest"), 4n);
  assert.equal(divide(-7n, 2n, "floor"), -4n);
  assert.equal(divide(-7n, 2n, "ceil"), -3n);
  assert.equal(divide(-7n, 2n, "nearest"), -4n);
  assert.equal(divide(5n, 3n, "nearest"), 2n);
  assert.equal(divide(-5n, 3n, "nearest"), -2n);
  assert.equal(divide(4n, -2n, "exact"), -2n);
  assert.throws(() => divide(7n, 2n, "exact"), /not exactly representable/);
  assert.throws(() => divide(1n, 0n, "floor"), /zero/);
});

test("NTSC conversions stay exact where float arithmetic is unsafe", () => {
  const fps = rational(60000, 1001);
  // Beyond ~213 s, ticks * 60000 exceeds 2^53; BigInt intermediates keep it exact.
  const frames = 60000 * 3600; // one hour of frames at 60000/1001
  const ticks = framesToTicks(frames, fps);
  assert.ok(
    !Number.isSafeInteger(ticks * 60000),
    "the float intermediate is unsafe",
  );
  assert.equal(ticks, (frames * 1001 * FLICKS_PER_SECOND) / 60000);
  assert.equal(ticksToFrames(ticks, fps), frames);
  assert.throws(() => ticksToFrames(ticks + 1, fps), /not exactly/);
  assert.equal(ticksToFrames(ticks + 1, fps, "floor"), frames);
  assert.equal(ticksToFrames(ticks + 1, fps, "ceil"), frames + 1);
});

test("property: frame → tick → frame round-trips for random frames and rates", () => {
  const rand = lcg(20261011);
  const rates = [
    rational(24, 1),
    rational(25, 1),
    rational(30, 1),
    rational(24000, 1001),
    rational(30000, 1001),
    rational(60000, 1001),
    rational(120, 1),
  ];
  for (let i = 0; i < 5000; i++) {
    const fps = rates[rand(rates.length)];
    const frames = rand(10_000_000);
    const ticks = framesToTicks(frames, fps);
    assert.equal(ticksToFrames(ticks, fps), frames);
    // Any tick inside a frame floors back to that frame.
    const inside = ticks + rand(Math.max(1, framesToTicks(1, fps, "floor")));
    assert.equal(ticksToFrames(inside, fps, "floor"), frames);
  }
});

test("source PTS in non-flick time bases converts with explicit rounding", () => {
  const mp4 = rational(1, 15360);
  // 1/15360 s is 45937.5 flicks: odd PTS values are not exact.
  assert.equal(ptsToTicks(2, mp4), 91_875);
  assert.throws(() => ptsToTicks(1, mp4), /not exactly/);
  assert.equal(ptsToTicks(1, mp4, "floor"), 45_937);
  assert.equal(ptsToTicks(1, mp4, "nearest"), 45_938);
  assert.equal(ticksToPts(91_875, mp4), 2);
  const rand = lcg(7);
  for (let i = 0; i < 2000; i++) {
    const pts = rand(1_000_000_000);
    const ticks = ptsToTicks(pts, mp4, "floor");
    // Floor in, ceil back out recovers the original PTS.
    assert.equal(ticksToPts(ticks, mp4, "ceil"), pts);
  }
  assert.equal(ptsToTicks(90000, rational(1, 90000)), FLICKS_PER_SECOND);
});

test("unsafe values and malformed rationals are rejected", () => {
  assert.throws(
    () => framesToTicks(Number.MAX_SAFE_INTEGER, rational(1, 1)),
    /safe-integer/,
  );
  assert.throws(() => framesToTicks(1.5, rational(30, 1)), /safe integer/);
  assert.throws(() => addTicks(Number.MAX_SAFE_INTEGER, 1), /safe-integer/);
  assert.throws(() => rational(0, 1), RangeError);
  assert.deepEqual(rational(60, 2), { num: 30, den: 1 });
  assert.equal(RationalSchema.safeParse({ num: 60, den: 2 }).success, false);
  assert.equal(
    RationalSchema.safeParse({ num: 30, den: 1, x: 1 }).success,
    false,
  );
  assert.equal(RationalSchema.safeParse({ num: 30, den: 0 }).success, false);
});
