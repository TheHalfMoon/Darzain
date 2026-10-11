// Adapted from OpenCut Classic (MIT) apps/web/src/timeline/placement/overlap.ts
// @ cf5e79e919144200294fb9fed22a222592a0aeea. Yamakan changes: elements are
// Yamakan clips ({ id, startTicks, durationTicks }) in integer flick ticks.

export interface PlacementTimeSpan {
  startTime: number;
  duration: number;
  excludeElementId?: string;
}

interface TimedElement {
  id: string;
  startTicks: number;
  durationTicks: number;
}

interface TrackWithElements {
  elements: TimedElement[];
}

function wouldElementOverlap({
  elements,
  startTime,
  endTime,
  excludeElementId,
}: {
  elements: TimedElement[];
  startTime: number;
  endTime: number;
  excludeElementId?: string;
}): boolean {
  return elements.some((element) => {
    if (excludeElementId && element.id === excludeElementId) {
      return false;
    }

    const elementEnd = element.startTicks + element.durationTicks;
    return startTime < elementEnd && endTime > element.startTicks;
  });
}

export function canPlaceTimeSpansOnTrack({
  track,
  timeSpans,
}: {
  track: TrackWithElements;
  timeSpans: PlacementTimeSpan[];
}): boolean {
  return timeSpans.every(({ startTime, duration, excludeElementId }) => {
    return !wouldElementOverlap({
      elements: track.elements,
      startTime,
      endTime: startTime + duration,
      excludeElementId,
    });
  });
}
