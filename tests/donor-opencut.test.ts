// Qualification fixtures for the adapted OpenCut placement and snapping helpers
// (core/donors/opencut) before the reducers rely on them.
import test from "node:test";
import assert from "node:assert/strict";
import { canPlaceTimeSpansOnTrack } from "../core/donors/opencut/overlap.ts";
import { resolveTimelineSnap } from "../core/donors/opencut/snapping.ts";

const track = {
  elements: [
    { id: "a", startTicks: 100, durationTicks: 100 },
    { id: "b", startTicks: 300, durationTicks: 50 },
  ],
};
const fits = (startTime: number, duration: number, exclude?: string) =>
  canPlaceTimeSpansOnTrack({
    track,
    timeSpans: [{ startTime, duration, excludeElementId: exclude }],
  });

test("spans that touch an element's edges fit; any shared tick does not", () => {
  assert.equal(fits(0, 100), true, "ends where a begins");
  assert.equal(fits(200, 100), true, "fills the gap exactly");
  assert.equal(fits(350, 10), true, "begins where b ends");
  assert.equal(fits(0, 101), false, "one tick into a");
  assert.equal(fits(199, 2), false, "straddles a's end");
  assert.equal(fits(299, 1), true, "ends where b begins");
  assert.equal(fits(299, 2), false, "one tick into b");
});

test("a span inside or around an element overlaps it", () => {
  assert.equal(fits(120, 10), false, "inside a");
  assert.equal(fits(50, 400), false, "covers both");
  assert.equal(fits(100, 100), false, "exactly a");
});

test("an element is excluded only from its own check", () => {
  assert.equal(fits(150, 100, "a"), true, "a may move within its own span");
  assert.equal(fits(150, 200, "a"), false, "but not onto b");
  assert.equal(fits(150, 100, "b"), false, "excluding b does not hide a");
});

test("every span of a multi-span placement must fit", () => {
  assert.equal(
    canPlaceTimeSpansOnTrack({
      track,
      timeSpans: [
        { startTime: 0, duration: 100 },
        { startTime: 200, duration: 100 },
      ],
    }),
    true,
  );
  assert.equal(
    canPlaceTimeSpansOnTrack({
      track,
      timeSpans: [
        { startTime: 0, duration: 100 },
        { startTime: 320, duration: 10 },
      ],
    }),
    false,
  );
});

test("snapping picks the nearest point within the threshold, inclusively", () => {
  const points = [
    { time: 100, type: "element-start" as const },
    { time: 200, type: "element-end" as const },
  ];
  const snap = (targetTime: number, maxSnapDistance: number) =>
    resolveTimelineSnap({ targetTime, snapPoints: points, maxSnapDistance });
  assert.deepEqual(
    [snap(108, 10).snappedTime, snap(108, 10).snapDistance],
    [100, 8],
  );
  assert.equal(snap(110, 10).snappedTime, 100, "the threshold is inclusive");
  assert.equal(snap(111, 10).snappedTime, 111, "beyond it nothing snaps");
  assert.equal(snap(111, 10).snapPoint, null);
  assert.equal(snap(111, 10).snapDistance, Infinity);
  assert.equal(snap(195, 100).snappedTime, 200, "the nearer point wins");
  assert.equal(snap(150, 50).snappedTime, 100, "a tie keeps the first point");
  assert.equal(
    resolveTimelineSnap({ targetTime: 5, snapPoints: [], maxSnapDistance: 10 })
      .snappedTime,
    5,
  );
});
