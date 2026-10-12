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
};

const SEGMENT_FRAMES = 60;

export function ReferencePreview(props: Props) {
  const { projectId, revision, totalFrames, unsaved, playing } = props;
  const frame = Math.max(0, Math.min(totalFrames - 1, props.frame));
  // Follow the playhead only once it rests, so scrubbing does not queue
  // renders; nothing is requested during playback.
  const [settled, setSettled] = useState(frame);
  useEffect(() => {
    if (playing) return;
    const timer = setTimeout(() => setSettled(frame), 250);
    return () => clearTimeout(timer);
  }, [frame, playing]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [segment, setSegment] = useState<string | null>(null);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/preview?revision=${revision}`;
  const src = `${base}&kind=frame&start=${settled}`;
  useEffect(() => setState("loading"), [src]);
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
          data-state={state}
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
        />
      )}
      {state === "loading" && !segment ? <small>Rendering…</small> : null}
      {state === "error" && !segment ? (
        <small className="error">
          The reference preview could not be rendered for this revision.
        </small>
      ) : null}
    </div>
  );
}
