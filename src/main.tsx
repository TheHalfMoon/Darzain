import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectSchema } from "../core/project.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";
import type { Project } from "../core/project.ts";
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
import { ReferencePreview } from "./reference.tsx";
import {
  direction,
  initialLang,
  saveLang,
  translate,
  formatNumber,
  formatDate,
  formatPercent,
  formatSeconds,
} from "./i18n.ts";
import type { Lang, MessageKey } from "./i18n.ts";
import {
  deleteClip,
  splitClip,
  updateClips as applyClipUpdates,
} from "./edit-ops.ts";
import { YamakanClient } from "../sdk/client.ts";
import type {
  Operation,
  OperationInput,
  OperationResult,
} from "../sdk/client.ts";
import "./donors/film-editor/editor.css";
import "./style.css";
// The UI is a same-origin client of the shared command registry; its session
// cookie identifies the browser-ui principal.
const client = new YamakanClient();
// A status line: a message key (re-translated when the language changes)
// or text from elsewhere (service errors), shown as given.
type Status =
  string | { key: MessageKey; vars?: Record<string, string | number> };
const msg = (key: MessageKey, vars?: Record<string, string | number>) => ({
  key,
  vars,
});
const call = <O extends Operation>(
  operation: O,
  parameters: OperationInput<O>,
) => client.call(operation, parameters);
function App() {
  // Interface language: Arabic lays the page out right to left; the
  // timeline keeps left-to-right time.
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(lang, key, vars);
  // Applied before paint, so an Arabic page never shows left to right
  // first; the choice is stored only when the user makes it.
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = direction(lang);
  }, [lang]);
  const [history, setHistory] = useState<ReturnType<
      typeof createHistoryState<Project>
    > | null>(null),
    [projects, setProjects] = useState<any[]>([]),
    [message, setMessage] = useState<Status>(msg("status.initial")),
    [busy, setBusy] = useState(false),
    // null until edited: the default name follows the interface language.
    [name, setName] = useState<string | null>(null),
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
    ),
    // Workspace backups, loaded on request.
    [backups, setBackups] =
      useState<OperationResult<"yamakan.workspace.backups"> | null>(null);
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
      setMessage(e instanceof Error ? e.message : t("error.operation"));
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
        setMessage(e instanceof Error ? e.message : t("error.edit"));
        return h;
      }
    });
  };
  const accept = (project: Project) => {
    setHistory(createHistoryState(ProjectSchema.parse(project)));
    setMessage(
      msg("status.opened", { name: project.name, revision: project.revision }),
    );
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
    setMessage(msg("status.saved", { revision: saved.revision }));
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
      if (!a) throw new Error(t("error.assetMissing"));
      const kind = a.kind === "audio" ? "audio" : "video";
      const track = trackId
        ? p.tracks.find((x) => x.id === trackId)
        : p.tracks.find(
            (x) => x.id === activeTrack && x.kind === kind && !x.locked,
          ) ||
          p.tracks.find((x) => x.targeted && x.kind === kind && !x.locked) ||
          p.tracks.find((x) => x.kind === kind && !x.locked);
      if (!track || track.locked || track.kind !== kind)
        throw new Error(t("error.track"));
      const start =
        time === undefined
          ? Math.max(
              0,
              ...p.clips
                .filter((c) => c.trackId === track.id)
                .map((c) => c.startFrame + c.durationFrames),
            )
          : Math.round(time * 30);
      return {
        ...p,
        clips: [
          ...p.clips,
          {
            id: crypto.randomUUID(),
            trackId: track.id,
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
    edit((p) => applyClipUpdates(p, updates));
  return (
    <div className="app">
      <header>
        <div className="identity">
          <span className="mark">D</span>
          <div>
            <strong>YAMAKAN</strong>
            <small>{t("brand.tagline")}</small>
          </div>
        </div>
        <nav>
          <button onClick={() => setTools(false)} aria-pressed={!tools}>
            {t("nav.production")}
          </button>
          <button onClick={() => setTools(true)} aria-pressed={tools}>
            {t("nav.tools")}
          </button>
        </nav>
        <span className="badge">{t("badge.local")}</span>
        {/* The visible text (the other language's name) is the accessible
            name; it is marked with its own language. */}
        <button
          type="button"
          className="language"
          title={t("lang.label")}
          onClick={() => {
            const next = lang === "ar" ? "en" : "ar";
            saveLang(next);
            setLang(next);
          }}
        >
          <span lang={lang === "ar" ? "en" : "ar"}>{t("lang.switch")}</span>
        </button>
      </header>
      <div role="status" className="status" dir="auto">
        {busy
          ? t("status.working")
          : typeof message === "string"
            ? message
            : t(message.key, message.vars)}
      </div>
      <div className="workspace">
        <aside>
          <h2>{t("projects.title")}</h2>
          <label>
            {t("projects.name")}
            <input
              dir="auto"
              value={name ?? t("projects.defaultName")}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (history?.past.length) await save();
                accept(
                  await call("yamakan.project.create", {
                    name: name ?? t("projects.defaultName"),
                  }),
                );
                await refresh();
              })
            }
          >
            {t("projects.create")}
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
                  <bdi>{item.name}</bdi>
                  <small dir="auto">
                    {item.error ||
                      t("projects.revision", { revision: item.revision })}
                  </small>
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
                  {t("projects.history")}
                </button>
              </div>
            ))}
          </div>
          <section className="backups" aria-label={t("backups.title")}>
            <h2>{t("backups.title")}</h2>
            <p className="note">{t("backups.note")}</p>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const made = await call("yamakan.workspace.backup", {});
                  setBackups(await call("yamakan.workspace.backups", {}));
                  setMessage(
                    made.damaged
                      ? msg("backups.madeDamaged", { count: made.damaged })
                      : msg("backups.made"),
                  );
                })
              }
            >
              {t("backups.create")}
            </button>
            {!backups && (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setBackups(await call("yamakan.workspace.backups", {})),
                  )
                }
              >
                {t("backups.show")}
              </button>
            )}
            {backups && backups.length === 0 && <p>{t("backups.none")}</p>}
            {backups && backups.length > 0 && (
              <ul className="backup-list">
                {backups.map((b) => (
                  <li key={b.backupId}>
                    {b.complete ? (
                      <>
                        <span>
                          {t("backups.summary", {
                            date: formatDate(lang, b.createdAt),
                            projects: b.projects,
                            size: Math.max(1, Math.ceil(b.bytes / 1e6)),
                          })}
                        </span>
                        {b.damaged > 0 && (
                          <small className="error">
                            {t("backups.damaged", { count: b.damaged })}
                          </small>
                        )}
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              const restored = await call(
                                "yamakan.workspace.restore",
                                { backupId: b.backupId },
                              );
                              setMessage(
                                restored.quarantined.length
                                  ? msg("backups.restoredQuarantined", {
                                      folder: restored.root,
                                      count: restored.quarantined.length,
                                    })
                                  : msg("backups.restored", {
                                      folder: restored.root,
                                    }),
                              );
                            })
                          }
                        >
                          {t("backups.restore")}
                        </button>
                      </>
                    ) : (
                      <span>{t("backups.incomplete", { id: b.backupId })}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {p && (
            <>
              <h2>
                {t("assets.title")}{" "}
                <span>{formatNumber(lang, p.assets.length)}</span>
              </h2>
              <input
                ref={input}
                type="file"
                aria-label={t("assets.import")}
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
                    if (!r.ok)
                      throw new Error(v.error?.message || t("import.failed"));
                    if (v.job) {
                      // Variable-frame-rate video: wait for its constant-rate version.
                      setMessage(msg("import.converting", { name: file.name }));
                      let job = v.job;
                      // Stop waiting (the job continues) after twice the
                      // conversion time limit, queueing included.
                      const deadline =
                        Date.now() +
                        2000 * RESOURCE_POLICY.enforced.conversionWallSeconds;
                      while (
                        job.state === "QUEUED" ||
                        job.state === "RUNNING"
                      ) {
                        if (Date.now() > deadline)
                          throw new Error(
                            t("import.stillConverting", { name: file.name }),
                          );
                        await new Promise((resolve) =>
                          setTimeout(resolve, 500),
                        );
                        job = await call("yamakan.job.status", {
                          jobId: job.id,
                        });
                      }
                      if (job.state !== "COMPLETED")
                        throw new Error(job.error || t("import.incomplete"));
                      accept(
                        await call("yamakan.project.open", { projectId: p.id }),
                      );
                      setMessage(msg("import.converted", { name: file.name }));
                    } else {
                      accept(v.project);
                      setMessage(msg("import.done", { name: v.asset.name }));
                    }
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
                      <bdi>{a.name}</bdi>
                      <small>
                        {t(`assets.kind.${a.kind}`)} ·{" "}
                        {t("assets.size", { kb: Math.round(a.bytes / 1024) })}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="hint">{t("hint.media")}</p>
        </aside>
        <main>
          {revisionHistory && (
            <section className="tools" aria-label={t("history.label")}>
              <h2>{t("history.title")}</h2>
              <p>
                {t("history.current", {
                  id: revisionHistory.projectId,
                  revision:
                    revisionHistory.currentRevision ?? t("history.unverified"),
                })}
              </p>
              <p>{t("history.note")}</p>
              {revisionHistory.currentRevision === null && (
                <p className="error">{t("history.unverifiable")}</p>
              )}
              {revisionHistory.snapshots.map((snapshot) => (
                <div key={snapshot.revision} className="scene">
                  <span>
                    {t("history.item", {
                      revision: snapshot.revision,
                      name: snapshot.name || snapshot.error || "",
                    })}
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
                    {t("history.restore", { revision: snapshot.revision })}
                  </button>
                </div>
              ))}
              {history?.past.length ? (
                <>
                  <p>{t("history.saveFirst")}</p>
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
                    {t("history.downloadDraft")}
                  </button>
                </>
              ) : null}
              <button onClick={() => setRevisionHistory(null)}>
                {t("history.close")}
              </button>
            </section>
          )}
          {tools ? (
            <section className="tools">
              <h1>{t("tools.title")}</h1>
              <p>{t("tools.intro")}</p>
              <pre>npm run cli -- yamakan.project.list {"{}"}</pre>
              <p>
                <a href="/api/v1/tools" target="_blank" rel="noreferrer">
                  {t("tools.catalog")}
                </a>
              </p>
              <p>{t("tools.jobs")}</p>
            </section>
          ) : p && view ? (
            <>
              <div className="toolbar">
                <div>
                  <h1 dir="auto">{p.name}</h1>
                  <small>
                    {t("projects.revision", { revision: p.revision })}
                    {history.past.length ? ` · ${t("toolbar.unsaved")}` : ""}
                  </small>
                </div>
                <div className="actions">
                  <button
                    disabled={busy || !history.past.length}
                    onClick={() => setHistory((h) => h && undoHistoryState(h))}
                  >
                    {t("action.undo")}
                  </button>
                  <button
                    disabled={busy || !history.future.length}
                    onClick={() => setHistory((h) => h && redoHistoryState(h))}
                  >
                    {t("action.redo")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await save();
                      })
                    }
                  >
                    {t("action.save")}
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
                    {t("action.export")}
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
                      {playing ? t("transport.pause") : t("transport.play")}
                    </button>
                    <input
                      aria-label={t("transport.playhead")}
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
                    <span>
                      {t("transport.seconds", {
                        seconds: formatSeconds(lang, playhead),
                      })}
                    </span>
                  </div>
                  <ReferencePreview
                    projectId={p.id}
                    revision={p.revision}
                    frame={Math.round(playhead * 30)}
                    totalFrames={Math.max(
                      0,
                      ...p.clips.map((c) => c.startFrame + c.durationFrames),
                    )}
                    unsaved={history.past.length > 0}
                    playing={playing}
                    onSave={() => run(async () => void (await save()))}
                    t={t}
                  />
                </section>
                <section className="inspector">
                  <h2>{t("scene.heading")}</h2>
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
                    {t("scene.add")}
                  </button>
                  {p.scenes.map((s) => (
                    <div className="scene" key={s.id}>
                      <label>
                        {t("scene.name")}
                        <input
                          dir="auto"
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
                        {t("scene.focal")}
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
                        {t("scene.scale")}
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
                          {(["wide", "medium", "close"] as const).map((v) => (
                            <option key={v} value={v}>
                              {t(`scene.scale.${v}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t("scene.movement")}
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
                          {(["static", "dolly", "pan", "orbit"] as const).map(
                            (v) => (
                              <option key={v} value={v}>
                                {t(`scene.movement.${v}`)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    </div>
                  ))}
                  <p className="hint">{t("hint.camera")}</p>
                  <h2>{t("title.heading")}</h2>
                  <label>
                    {t("title.text")}
                    <input
                      dir="auto"
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
                    {t("title.add")}
                  </button>
                  {job && (
                    <div className="job" role="status">
                      <strong>{t(`job.${job.state}`)}</strong>
                      <progress max="1" value={job.progress} />
                      <small>{formatPercent(lang, job.progress)}</small>
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
                          {t("job.cancel")}
                        </button>
                      )}
                      {job.state === "COMPLETED" && (
                        <a
                          className="download"
                          href={`/api/v1/jobs/${job.id}/artifact`}
                        >
                          {t("job.download")}
                        </a>
                      )}
                      {job.error && (
                        <p className="error" dir="auto">
                          {job.error}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              </div>
              {/* Time runs left to right in every interface language. */}
              <section className="timeline" dir="ltr">
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
                    edit((p) => splitClip(p, id, time, crypto.randomUUID()))
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
                  onDeleteClip={() => edit((p) => deleteClip(p, selected))}
                />
              </section>
            </>
          ) : (
            <section className="empty">
              <span className="large-mark">D</span>
              <h1>{t("empty.title")}</h1>
              <p>{t("empty.body")}</p>
              <p>{t("empty.persist")}</p>
            </section>
          )}
        </main>
      </div>
      <footer>{t("footer")}</footer>
    </div>
  );
}
// The page starts in the chosen language and direction before React draws.
document.documentElement.lang = initialLang();
document.documentElement.dir = direction(initialLang());
createRoot(document.getElementById("root")!).render(<App />);
