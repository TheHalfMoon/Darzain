// Adapted from OpenCut Classic (MIT) apps/web/src/timeline/snapping/{build,resolve}.ts
// @ cf5e79e919144200294fb9fed22a222592a0aeea. Yamakan changes: integer flick
// ticks instead of the wasm MediaTime brand, and the snap distance is
// reported as a tick count (Infinity when nothing snapped is unchanged).

export type SnapPointType =
  | "element-start"
  | "element-end"
  | "playhead"
  | "bookmark"
  | "keyframe";

export interface SnapPoint {
  time: number;
  type: SnapPointType;
  elementId?: string;
  trackId?: string;
}

export interface SnapResult {
  snappedTime: number;
  snapPoint: SnapPoint | null;
  snapDistance: number;
}

export type TimelineSnapPointSource = () => Iterable<SnapPoint>;

export function buildTimelineSnapPoints({
  sources,
}: {
  sources: TimelineSnapPointSource[];
}): SnapPoint[] {
  const snapPoints: SnapPoint[] = [];

  for (const source of sources) {
    for (const snapPoint of source()) {
      snapPoints.push(snapPoint);
    }
  }

  return snapPoints;
}

export function resolveTimelineSnap({
  targetTime,
  snapPoints,
  maxSnapDistance,
}: {
  targetTime: number;
  snapPoints: SnapPoint[];
  maxSnapDistance: number;
}): SnapResult {
  let closestSnapPoint: SnapPoint | null = null;
  let closestDistance = Infinity;

  for (const snapPoint of snapPoints) {
    const distance = Math.abs(targetTime - snapPoint.time);
    if (distance <= maxSnapDistance && distance < closestDistance) {
      closestDistance = distance;
      closestSnapPoint = snapPoint;
    }
  }

  return {
    snappedTime: closestSnapPoint ? closestSnapPoint.time : targetTime,
    snapPoint: closestSnapPoint,
    snapDistance: closestDistance,
  };
}
