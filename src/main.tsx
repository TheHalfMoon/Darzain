import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectSchema } from "../core/project.ts";
import type { Project, Clip } from "../core/project.ts";
import type { RenderJob } from "../core/render.ts";
import type { ProjectHistory } from "../core/store.ts";
import Timeline from "./donors/film-editor/components/Timeline";
import PreviewPlayer from "./donors/film-editor/components/PreviewPlayer";
import type { TimelineClip } from "./donors/film-editor/types";
import {
  createHistoryState,
  pushHistoryState,
  undoHistoryState,
  redoHistoryState,
} from "./donors/film-editor/utils/historyState";
import { editorView } from "./adapter";
import { YamakanClient } from "../sdk/client.ts";
import type { Operation, OperationInput } from "../sdk/client.ts";
import "./donors/film-editor/editor.css";
import "./style.css";
// The UI is a same-origin client of the shared command registry; its session
// cookie identifies the browser-ui principal.
const client = new YamakanClient();
const call = <O extends Operation>(
  operation: O,
  parameters: OperationInput<O>,
) => client.call(operation, parameters);
function App() {
  const [history, setHistory] = useState<ReturnType<
      typeof createHistoryState<Project>
    > | null>(null),
    [projects, setProjects] = useState<any[]>([]),
    [message, setMessage] = useState("Create or open a project to begin."),
    [busy, setBusy] = useState(false),
    [name, setName] = useState("Untitled production"),
    [title, setTitle] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [playhead, setPlayhead] = useState(0),
    [playing, setPlaying] = useState(false),
    [snapping, setSnapping] = useState(true),
    [activeTrack, setActiveTrack] = useState<string | null>(null),
    [job, setJob] = useState<RenderJob | null>(null),
    [tools, setTools] = useState(false),
    [downloadedDraft, setDownloadedDraft] = useState<Project | null>(null),
    [revisionHistory, setRevisionHistory] = useState<ProjectHistory | null>(
      null,
    );
  const input = useRef<HTMLInputElement>(null);
  const p = history?.present;
  const current = useRef(p);
  current.current = p;
  const refresh = async () =>
    setProjects(await call("yamakan.project.list", {}));
  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const edit = (fn: (p: Project) => Project) => {
    if (busy) return;
    setHistory((h) => {
      if (!h) return h;
      try {
        return pushHistoryState(h, ProjectSchema.parse(fn(h.present)));
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Invalid edit.");
        return h;
      }
    });
  };
  const accept = (project: Project) => {
    setHistory(createHistoryState(ProjectSchema.parse(project)));
    setMessage(`Opened ${project.name}, revision ${project.revision}.`);
    setSelected(null);
    setPlayhead(0);
    setPlaying(false);
    setRevisionHistory(null);
    setDownloadedDraft(null);
  };
  const save = async () => {
    if (!current.current) return;
    const saved = await call("yamakan.project.save", {
      project: current.current,
      expectedRevision: current.current.revision,
    });
    accept(saved);
    await refresh();
    setMessage(`Saved revision ${saved.revision}.`);
    return saved as Project;
  };
  const sequenceDuration = p
    ? Math.max(0, ...p.clips.map((c) => (c.startFrame + c.durationFrames) / 30))
    : 0;
  useEffect(() => {
    if (!playing || !p) return;
    const start = performance.now(),
      at = playhead,
      total = sequenceDuration;
    const timer = setInterval(() => {
      const pos = at + (performance.now() - start) / 1000;
      setPlayhead(Math.min(total, pos));
      if (pos >= total) setPlaying(false);
    }, 33);
    return () => clearInterval(timer);
  }, [playing, p?.id, sequenceDuration]);
  useEffect(() => {
    if (!job || ["COMPLETED", "FAILED", "CANCELLED"].includes(job.state))
      return;
    const timer = setInterval(() => {
      call("yamakan.job.status", { jobId: job.id })
        .then(setJob)
        .catch((e) => {
          setMessage(e.message);
          clearInterval(timer);
        });
    }, 500);
    return () => clearInterval(timer);
  }, [job?.id, job?.state]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (history && history.past.length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [history]);
  const view = p ? editorView(p) : null;
  const addAsset = (assetId: string, trackId?: string, time?: number) =>
    edit((p) => {
      const a = p.assets.find((a) => a.id === assetId);
      if (!a) throw new Error("Asset missing.");
      const kind = a.kind === "audio" ? "audio" : "video";
      const t = trackId
        ? p.tracks.find((t) => t.id === trackId)
        : p.tracks.find(
            (t) => t.id === activeTrack && t.kind === kind && !t.locked,
          ) ||
          p.tracks.find((t) => t.targeted && t.kind === kind && !t.locked) ||
          p.tracks.find((t) => t.kind === kind && !t.locked);
      if (!t || t.locked || t.kind !== kind)
        throw new Error("Choose an unlocked compatible track.");
      const start =
        time === undefined
          ? Math.max(
              0,
              ...p.clips
                .filter((c) => c.trackId === t.id)
                .map((c) => c.startFrame + c.durationFrames),
            )
          : Math.round(time * 30);
      return {
        ...p,
        clips: [
          ...p.clips,
          {
            id: crypto.randomUUID(),
            trackId: t.id,
            assetId: a.id,
            startFrame: start,
            durationFrames:
              a.kind === "image" ? 90 : Math.min(a.durationFrames, 150),
            sourceFrame: 0,
            title: null,
          },
        ],
      };
    });
  const updateClips = (updates: TimelineClip[]) =>
    edit((p) => ({
      ...p,
      clips: updates.reduce((clips, c) => {
        const existing = clips.find((x) => x.id === c.id);
        const old =
          existing ||
          clips.find(
            (x) => x.assetId === c.mediaId || `title-${x.id}` === c.mediaId,
          );
        if (!old) return clips;
        if (
          (existing && p.tracks.find((t) => t.id === old.trackId)?.locked) ||
          p.tracks.find((t) => t.id === c.trackId)?.locked
        )
          return clips;
        const converted: Clip = {
          ...old,
          id: c.id,
          trackId: c.trackId,
          startFrame: Math.max(0, Math.round(c.start * 30)),
          durationFrames: Math.max(1, Math.round((c.end - c.start) * 30)),
          sourceFrame:
            old !== undefined && old.title !== null
              ? 0
              : Math.max(0, Math.round((c.sourceIn || 0) * 30)),
        };
        return clips.some((x) => x.id === c.id)
          ? clips.map((x) => (x.id === c.id ? converted : x))
          : [...clips, converted];
      }, p.clips),
    }));
  return (
    <div className="app">
      <header>
        <div className="identity">
          <span className="mark">D</span>
          <div>
            <strong>YAMAKAN</strong>
            <small>Creative production · Offline workspace</small>
          </div>
        </div>
        <nav>
          <button onClick={() => setTools(false)} aria-pressed={!tools}>
            Production
          </button>
          <button onClick={() => setTools(true)} aria-pressed={tools}>
            Agent tools
          </button>
        </nav>
        <span className="badge">Local media · CPU rendering</span>
      </header>
      <div role="status" className="status">
        {busy ? "Working…" : message}
      </div>
      <div className="workspace">
        <aside>
          <h2>Projects</h2>
          <label>
            Project name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (history?.past.length) await save();
                accept(await call("yamakan.project.create", { name }));
                await refresh();
              })
            }
          >
            Create project
          </button>
          <div className="project-list">
            {projects.map((item) => (
              <div key={item.id}>
                <button
                  disabled={busy || item.error}
                  onClick={() =>
                    run(async () => {
                      if (history?.past.length) await save();
                      accept(
                        await call("yamakan.project.open", {
                          projectId: item.id,
                        }),
                      );
                    })
                  }
                >
                  {item.name}
                  <small>{item.error || `Revision ${item.revision}`}</small>
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setRevisionHistory(
                        await call("yamakan.project.history", {
                          projectId: item.id,
                        }),
                      );
                    })
                  }
                >
                  History & recovery
                </button>
              </div>
            ))}
          </div>
          {p && (
            <>
              <h2>
                Assets <span>{p.assets.length}</span>
              </h2>
              <input
                ref={input}
                type="file"
                aria-label="Import local media"
                accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.wav,.mp3,.ogg"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  run(async () => {
                    await save();
                    const r = await fetch(`/api/v1/projects/${p.id}/assets`, {
                      method: "POST",
                      headers: {
                        "X-Asset-Name": encodeURIComponent(file.name),
                      },
                      body: file,
                    });
                    const v = await r.json();
                    if (!r.ok) throw new Error(v.error);
                    accept(v.project);
                    setMessage(
                      `Imported ${v.asset.name}. Click it to add it to the timeline.`,
                    );
                    await refresh();
                  });
                }}
              />
              <div className="asset-list">
                {p.assets.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => addAsset(a.id)}
                    disabled={busy}
                  >
                    {a.kind === "image" && (
                      <img
                        src={`/api/v1/projects/${p.id}/assets/${a.id}`}
                        alt=""
                      />
                    )}
                    <span>
                      {a.name}
                      <small>
                        {a.kind} · {Math.round(a.bytes / 1024)} KB
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="hint">
            Media stays on this computer. Imported video sound is not mixed
            automatically; add a separate audio asset. No inference backend is
            enabled yet.
          </p>
        </aside>
        <main>
          {revisionHistory && (
            <section className="tools" aria-label="Project history">
              <h2>Project history & recovery</h2>
              <p>
                Project {revisionHistory.projectId} · Current revision{" "}
                {revisionHistory.currentRevision ?? "unverified"}
              </p>
              <p>
                Restoring creates a new revision. Existing snapshots and the
                previous head are preserved.
              </p>
              {revisionHistory.currentRevision === null && (
                <p className="error">
                  The current project cannot be verified. Choose a verified
                  snapshot to recover it.
                </p>
              )}
              {revisionHistory.snapshots.map((snapshot) => (
                <div key={snapshot.revision} className="scene">
                  <span>
                    Revision {snapshot.revision} ·{" "}
                    {snapshot.name || snapshot.error}
                  </span>
                  <button
                    disabled={
                      busy ||
                      !snapshot.verified ||
                      (!!history?.past.length &&
                        downloadedDraft !== history.present)
                    }
                    onClick={() =>
                      run(async () => {
                        accept(
                          await call("yamakan.project.restore", {
                            projectId: revisionHistory.projectId,
                            revision: snapshot.revision,
                            expectedHeadFingerprint:
                              revisionHistory.headFingerprint,
                          }),
                        );
                        await refresh();
                      })
                    }
                  >
                    Restore revision {snapshot.revision}
                  </button>
                </div>
              ))}
              {history?.past.length ? (
                <>
                  <p>
                    Save your edits or download an unsaved draft before
                    restoring. Draft JSON retains edits; media stays in this
                    workspace.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const draft = history.present;
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(draft, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = `yamakan-draft-${draft.id}.json`;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                      setDownloadedDraft(draft);
                    }}
                  >
                    Download unsaved draft
                  </button>
                </>
              ) : null}
              <button onClick={() => setRevisionHistory(null)}>
                Close history
              </button>
            </section>
          )}
          {tools ? (
            <section className="tools">
              <h1>Yamakan agent tools</h1>
              <p>
                The same validated project and render operations power the
                editor and local REST API.
              </p>
              <pre>npm run cli -- yamakan.project.list {"{}"}</pre>
              <p>
                <a href="/api/v1/tools" target="_blank" rel="noreferrer">
                  Open the versioned tool catalog
                </a>
              </p>
              <p>
                Jobs expose progress, cancellation, errors and verified video
                artifacts. Project paths and arbitrary commands are not accepted
                by the API.
              </p>
            </section>
          ) : p && view ? (
            <>
              <div className="toolbar">
                <div>
                  <h1>{p.name}</h1>
                  <small>
                    Revision {p.revision}
                    {history.past.length ? " · Unsaved changes" : ""}
                  </small>
                </div>
                <div className="actions">
                  <button
                    disabled={busy || !history.past.length}
                    onClick={() => setHistory((h) => h && undoHistoryState(h))}
                  >
                    Undo
                  </button>
                  <button
                    disabled={busy || !history.future.length}
                    onClick={() => setHistory((h) => h && redoHistoryState(h))}
                  >
                    Redo
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await save();
                      })
                    }
                  >
                    Save
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !p.clips.length ||
                      (job && ["QUEUED", "RUNNING"].includes(job.state)) ||
                      false
                    }
                    onClick={() =>
                      run(async () => {
                        const saved = await save();
                        if (saved)
                          setJob(
                            await call("yamakan.export.video", {
                              projectId: saved.id,
                              idempotencyKey: crypto.randomUUID(),
                            }),
                          );
                      })
                    }
                  >
                    Export video
                  </button>
                </div>
              </div>
              <div className="production">
                <section className="preview">
                  <PreviewPlayer
                    timelineClips={view.clips}
                    timelineTracks={view.tracks}
                    mediaItems={view.media}
                    playheadPosition={playhead}
                    isPlaying={playing}
                    onTogglePlayback={() => setPlaying((x) => !x)}
                    canvasWidth={p.width}
                    canvasHeight={p.height}
                    aspectStyle={{ aspectRatio: `${p.width}/${p.height}` }}
                    showControls
                  />
                  <div className="transport">
                    <button
                      onClick={() => setPlaying((x) => !x)}
                      disabled={!p.clips.length}
                    >
                      {playing ? "Pause" : "Play"}
                    </button>
                    <input
                      aria-label="Playhead"
                      type="range"
                      min="0"
                      step={1 / 30}
                      max={Math.max(
                        1,
                        ...p.clips.map(
                          (c) => (c.startFrame + c.durationFrames) / 30,
                        ),
                      )}
                      value={playhead}
                      onChange={(e) => {
                        setPlaying(false);
                        setPlayhead(Number(e.target.value));
                      }}
                    />
                    <span>{playhead.toFixed(2)} s</span>
                  </div>
                </section>
                <section className="inspector">
                  <h2>Scene & shot</h2>
                  <button
                    disabled={busy}
                    onClick={() =>
                      edit((p) => ({
                        ...p,
                        scenes: [
                          ...p.scenes,
                          {
                            id: crypto.randomUUID(),
                            name: `Scene ${p.scenes.length + 1}`,
                            referenceAssetId:
                              p.assets.find((a) => a.kind === "image")?.id ||
                              null,
                            camera: {
                              focalLengthMm: 50,
                              shotScale: "medium",
                              movement: "static",
                            },
                          },
                        ],
                      }))
                    }
                  >
                    Add scene
                  </button>
                  {p.scenes.map((s) => (
                    <div className="scene" key={s.id}>
                      <label>
                        Scene name
                        <input
                          value={s.name}
                          maxLength={120}
                          onChange={(e) =>
                            edit((p) => ({
                              ...p,
                              scenes: p.scenes.map((x) =>
                                x.id === s.id
                                  ? { ...x, name: e.target.value }
                                  : x,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Focal length (mm)
                        <input
                          type="number"
                          min="8"
                          max="300"
                          value={s.camera.focalLengthMm}
                          onChange={(e) =>
                            edit((p) => ({
                              ...p,
                              scenes: p.scenes.map((x) =>
                                x.id === s.id
                                  ? {
                                      ...x,
                                      camera: {
                                        ...x.camera,
                                        focalLengthMm: Number(e.target.value),
                                      },
                                    }
                                  : x,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Shot scale
                        <select
                          value={s.camera.shotScale}
                          onChange={(e) =>
                            edit((p) => ({
                              ...p,
                              scenes: p.scenes.map((x) =>
                                x.id === s.id
                                  ? {
                                      ...x,
                                      camera: {
                                        ...x.camera,
                                        shotScale: e.target.value as any,
                                      },
                                    }
                                  : x,
                              ),
                            }))
                          }
                        >
                          {["wide", "medium", "close"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Movement
                        <select
                          value={s.camera.movement}
                          onChange={(e) =>
                            edit((p) => ({
                              ...p,
                              scenes: p.scenes.map((x) =>
                                x.id === s.id
                                  ? {
                                      ...x,
                                      camera: {
                                        ...x.camera,
                                        movement: e.target.value as any,
                                      },
                                    }
                                  : x,
                              ),
                            }))
                          }
                        >
                          {["static", "dolly", "pan", "orbit"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ))}
                  <p className="hint">
                    Camera settings record shot intent. They do not change
                    imported footage.
                  </p>
                  <h2>Title</h2>
                  <label>
                    Title text
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={500}
                    />
                  </label>
                  <button
                    disabled={!title || busy}
                    onClick={() =>
                      edit((p) => {
                        const track = {
                          id: crypto.randomUUID(),
                          name: "Titles",
                          kind: "video" as const,
                          muted: false,
                          locked: false,
                        };
                        return {
                          ...p,
                          tracks: [...p.tracks, track],
                          clips: [
                            ...p.clips,
                            {
                              id: crypto.randomUUID(),
                              trackId: track.id,
                              assetId: null,
                              startFrame: 0,
                              durationFrames: 90,
                              sourceFrame: 0,
                              title,
                            },
                          ],
                        };
                      })
                    }
                  >
                    Add title
                  </button>
                  {job && (
                    <div className="job" role="status">
                      <strong>Export {job.state.toLowerCase()}</strong>
                      <progress max="1" value={job.progress} />
                      <small>{Math.round(job.progress * 100)}%</small>
                      {["QUEUED", "RUNNING"].includes(job.state) && (
                        <button
                          onClick={() =>
                            run(async () =>
                              setJob(
                                await call("yamakan.job.cancel", {
                                  jobId: job.id,
                                }),
                              ),
                            )
                          }
                        >
                          Cancel export
                        </button>
                      )}
                      {job.state === "COMPLETED" && (
                        <a
                          className="download"
                          href={`/api/v1/jobs/${job.id}/artifact`}
                        >
                          Download MP4
                        </a>
                      )}
                      {job.error && <p className="error">{job.error}</p>}
                    </div>
                  )}
                </section>
              </div>
              <section className="timeline">
                <Timeline
                  tracks={view.tracks}
                  clips={view.clips}
                  mediaItems={view.media}
                  selectedClipId={selected}
                  activeTrackId={activeTrack}
                  playheadPosition={playhead}
                  isSnappingEnabled={snapping}
                  trimMode="normal"
                  waveformCache={{}}
                  onSelectClip={setSelected}
                  onSetActiveTrack={setActiveTrack}
                  onUpdateClip={(c) => updateClips([c])}
                  onBatchUpdateClips={updateClips}
                  onPlayheadUpdate={(time) => {
                    setPlaying(false);
                    setPlayhead(time);
                  }}
                  onSnappingToggle={() => setSnapping((x) => !x)}
                  onSplitClip={(id, time) =>
                    edit((p) => {
                      const c = p.clips.find((c) => c.id === id);
                      if (
                        !c ||
                        p.tracks.find((t) => t.id === c.trackId)?.locked
                      )
                        return p;
                      const offset = Math.round(time * 30) - c.startFrame;
                      if (offset < 1 || offset >= c.durationFrames) return p;
                      return {
                        ...p,
                        clips: p.clips.flatMap((x) =>
                          x.id === id
                            ? [
                                { ...c, durationFrames: offset },
                                {
                                  ...c,
                                  id: crypto.randomUUID(),
                                  startFrame: c.startFrame + offset,
                                  sourceFrame:
                                    c.assetId &&
                                    p.assets.find((a) => a.id === c.assetId)
                                      ?.kind !== "image"
                                      ? c.sourceFrame + offset
                                      : 0,
                                  durationFrames: c.durationFrames - offset,
                                },
                              ]
                            : [x],
                        ),
                      };
                    })
                  }
                  onAddTrack={(kind) =>
                    edit((p) => ({
                      ...p,
                      tracks: [
                        ...p.tracks,
                        {
                          id: crypto.randomUUID(),
                          name: kind === "video" ? "Picture" : "Audio",
                          kind,
                          muted: false,
                          locked: false,
                        },
                      ],
                    }))
                  }
                  onUpdateTrack={(id, u) =>
                    edit((p) => ({
                      ...p,
                      tracks: p.tracks.map((t) =>
                        t.id === id
                          ? {
                              ...t,
                              name: u.name ?? t.name,
                              muted: u.isMuted ?? t.muted,
                              locked: u.isLocked ?? t.locked,
                              solo: u.isSolo ?? t.solo ?? false,
                              targeted: u.isTargeted ?? t.targeted ?? false,
                            }
                          : t,
                      ),
                    }))
                  }
                  onDropMedia={addAsset}
                  onDeleteClip={() =>
                    edit((p) => ({
                      ...p,
                      clips: p.clips.filter(
                        (c) =>
                          c.id !== selected ||
                          p.tracks.find((t) => t.id === c.trackId)?.locked,
                      ),
                    }))
                  }
                />
              </section>
            </>
          ) : (
            <section className="empty">
              <span className="large-mark">D</span>
              <h1>Your next production starts here.</h1>
              <p>
                Create a local project, import media, plan a shot, edit the
                timeline and export a playable video.
              </p>
              <p>
                Projects remain editable after closing and reopening Yamakan.
              </p>
            </section>
          )}
        </main>
      </div>
      <footer>
        Yamakan engineering preview · Project schema v1 · Offline workflows
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
