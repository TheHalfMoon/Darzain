// Reference preview (plan T8): the frame at the playhead of the saved
// revision, rendered by the same plan compiler, filtergraph, ASS titles and
// fonts as export. The interactive preview above it is fast but
// approximate; this one is what the export will contain. It always names
// the revision it shows, and says so plainly when there are unsaved edits.
import React, { useEffect, useState } from "react";

type Props = {
  projectId: string;
  revision: number;
  // Frame at the playhead (30 fps edit frames).
  frame: number;
  totalFrames: number;
  unsaved: boolean;
  playing: boolean;
  // Saves the edits, so the reference shows the current timeline.
  onSave: () => void;
};

const SEGMENT_FRAMES = 60;

export function ReferencePreview(props: Props) {
  const { projectId, revision, totalFrames, unsaved, playing, onSave } = props;
  const frame = Math.max(0, Math.min(totalFrames - 1, props.frame));
  // Follow the playhead only once it rests, so scrubbing does not queue
  // renders; nothing is requested during playback.
  const [settled, setSettled] = useState(frame);
  useEffect(() => {
    if (playing) return;
    const timer = setTimeout(() => setSettled(frame), 250);
    return () => clearTimeout(timer);
  }, [frame, playing]);
  // Which image finished, so a cached image that loads at once is never
  // shown as still rendering.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [segment, setSegment] = useState<string | null>(null);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/preview?revision=${revision}`;
  // A failed frame (busy renderer, transient error) is asked for again a
  // few times; the attempt number only changes the address.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [base, settled]);
  const src = `${base}&kind=frame&start=${settled}${attempt ? `&attempt=${attempt}` : ""}`;
  useEffect(() => {
    if (failed !== src || attempt >= 3) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [failed, src, attempt]);
  useEffect(() => setSegment(null), [projectId, revision]);
  if (totalFrames < 1)
    return (
      <div className="reference" role="region" aria-label="Reference preview">
        <p>Add a clip or title to see the reference preview.</p>
      </div>
    );
  return (
    <div className="reference" role="region" aria-label="Reference preview">
      <div className="reference-head">
        <strong>Reference preview</strong>
        <span>
          Saved revision {revision}, frame {settled}
          {unsaved ? " · Stale: save to include your latest edits" : ""}
        </span>
        {unsaved ? (
          <button type="button" onClick={onSave}>
            Save and refresh
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            setSegment(
              `${base}&kind=segment&start=${settled}&frames=${SEGMENT_FRAMES}`,
            )
          }
        >
          Play reference (2 s)
        </button>
      </div>
      {segment ? (
        <video
          key={segment}
          src={segment}
          controls
          autoPlay
          aria-label="Reference segment"
          onEnded={() => setSegment(null)}
        />
      ) : (
        <img
          src={src}
          alt={`Reference frame ${settled} of saved revision ${revision}`}
          data-state={
            failed === src ? "error" : loaded === src ? "ready" : "loading"
          }
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
        />
      )}
      {loaded !== src && failed !== src && !segment ? (
        <small>Rendering…</small>
      ) : null}
      {failed === src && !segment ? (
        <small className="error">
          The reference preview could not be rendered for this revision.
        </small>
      ) : null}
    </div>
  );
}
