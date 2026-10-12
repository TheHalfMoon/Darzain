import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { execute, Scopes } from "../core/command/registry.ts";
import { CommandError } from "../core/command/errors.ts";
import { mediaTools } from "../core/process/workers.ts";
import type { Operation } from "../core/timeline/operations.ts";

const F = 23_520_000; // flicks per 30 fps frame
const ids = {
  scene: "11111111-1111-4111-8111-111111111111",
  shot: "22222222-2222-4222-8222-222222222222",
  title: "33333333-3333-4333-8333-333333333333",
  title2: "44444444-4444-4444-8444-444444444444",
  tone: "55555555-5555-4555-8555-555555555555",
  extra: "66666666-6666-4666-8666-666666666666",
};

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-timeline-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Timeline");
  const wav = path.join(root, "tone.wav");
  execFileSync(
    mediaTools().ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      wav,
    ],
    { windowsHide: true },
  );
  const imported = await store.importAsset(
    project.id,
    "tone.wav",
    await readFile(wav),
  );
  const queue = new JobSupervisor(store);
  const ctx = {
    store,
    queue,
    principal: { id: "local-client" as const, scopes: new Set(Scopes) },
  };
  const call = (operation: string, parameters: unknown, requestId?: string) =>
    execute({ ...ctx, requestId }, operation, parameters).then(
      (r) => r.result as any,
    );
  return {
    root,
    store,
    queue,
    project: imported.project,
    audio: imported.asset,
    call,
  };
}

function tenOperations(
  p: { tracks: { id: string }[] },
  audioId: string,
): Operation[] {
  const [picture, sound] = p.tracks.map((t) => t.id);
  return [
    { type: "scene.add", sceneId: ids.scene, name: "Opening" },
    {
      type: "clip.add",
      clipId: ids.title,
      trackId: picture,
      assetId: null,
      title: "مرحبا · Hello",
      startTicks: 0,
      durationTicks: 60 * F,
      sourceStartTicks: 0,
    },
    {
      type: "clip.split",
      clipId: ids.title,
      atTicks: 30 * F,
      newClipId: ids.title2,
    },
    { type: "clip.setTitle", clipId: ids.title2, title: "Part two" },
    {
      type: "clip.add",
      clipId: ids.tone,
      trackId: sound,
      assetId: audioId,
      title: null,
      startTicks: 0,
      durationTicks: 90 * F,
      sourceStartTicks: 0,
    },
    { type: "clip.trim", clipId: ids.tone, startTicks: 15 * F },
    {
      type: "clip.setAudio",
      clipId: ids.tone,
      gainDb: -6,
      fadeInTicks: 10 * F,
      fadeOutTicks: 5 * F,
    },
    {
      type: "shot.add",
      sceneId: ids.scene,
      shotId: ids.shot,
      name: "Wide",
      clipIds: [ids.title],
    },
    { type: "clip.move", clipId: ids.title2, startTicks: 45 * F },
    { type: "track.update", trackId: sound, locked: true },
  ];
}

test("a ten-operation batch produces the specified snapshot as one revision", async () => {
  const { store, project, audio, call } = await workspace();
  const result = await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: tenOperations(project, audio.id),
  });
  assert.equal(
    result.revision,
    project.revision + 1,
    "one batch, one revision",
  );
  const p = await store.exportProject(project.id);
  const clip = (id: string) => p.clips.find((c) => c.id === id)!;
  assert.deepEqual(
    [
      clip(ids.title).startTicks,
      clip(ids.title).durationTicks,
      clip(ids.title).title,
    ],
    [0, 30 * F, "مرحبا · Hello"],
  );
  assert.deepEqual(
    [
      clip(ids.title2).startTicks,
      clip(ids.title2).durationTicks,
      clip(ids.title2).title,
    ],
    [45 * F, 30 * F, "Part two"],
  );
  const tone = clip(ids.tone);
  assert.deepEqual(
    [
      tone.startTicks,
      tone.durationTicks,
      tone.sourceStartTicks,
      tone.gainDb,
      tone.fadeInTicks,
      tone.fadeOutTicks,
    ],
    [15 * F, 75 * F, 15 * F, -6, 10 * F, 5 * F],
  );
  assert.deepEqual(p.scenes[0].shots, [
    { id: ids.shot, name: "Wide", clipIds: [ids.title] },
  ]);
  assert.equal(p.tracks[1].locked, true);
  // The same operations through the editing shape (the UI's save path) give
  // the same canonical project.
  const second = await workspace();
  const view = await second.store.load(second.project.id);
  const ops = tenOperations(view, second.audio.id);
  const { applyBatch } = await import("../core/timeline/operations.ts");
  const { fromEditView, toEditView } = await import("../core/canonical.ts");
  const edited = toEditView(applyBatch(fromEditView(view), ops));
  await second.store.save(
    { ...edited, revision: view.revision },
    view.revision,
  );
  const viaUi = await second.store.exportProject(second.project.id);
  const strip = (x: typeof p) => ({
    ...x,
    id: "",
    name: "",
    revision: 0,
    assets: x.assets.map((a) => ({ ...a, id: "" })),
    tracks: x.tracks.map((t) => ({ ...t, id: "" })),
    clips: x.clips.map((c) => ({
      ...c,
      trackId: "",
      assetId: c.assetId ? "asset" : null,
    })),
  });
  assert.deepEqual(strip(viaUi), strip(p));
  store.close();
  second.store.close();
});

test("a failing operation rejects the whole batch and commits nothing", async () => {
  const { store, project, audio, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const before = await store.exportProject(project.id);
  await assert.rejects(
    call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: project.revision,
      operations: [
        {
          type: "clip.add",
          clipId: ids.title,
          trackId: picture,
          assetId: null,
          title: "A",
          startTicks: 0,
          durationTicks: 30 * F,
          sourceStartTicks: 0,
        },
        {
          type: "clip.add",
          clipId: ids.title2,
          trackId: picture,
          assetId: null,
          title: "B",
          startTicks: 10 * F,
          durationTicks: 30 * F,
          sourceStartTicks: 0,
        },
      ],
    }),
    (e: unknown) =>
      e instanceof CommandError &&
      /Operation 2 \(clip.add\): Clips on a track cannot overlap/.test(
        e.message,
      ),
  );
  assert.deepEqual(await store.exportProject(project.id), before);
  // Locked tracks refuse edits; fades and gain apply to audio clips only.
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [
      {
        type: "clip.add",
        clipId: ids.title,
        trackId: picture,
        assetId: null,
        title: "A",
        startTicks: 0,
        durationTicks: 30 * F,
        sourceStartTicks: 0,
      },
      { type: "track.update", trackId: picture, locked: true },
    ],
  });
  for (const op of [
    { type: "clip.move", clipId: ids.title, startTicks: 60 * F },
    { type: "clip.remove", clipId: ids.title },
  ])
    await assert.rejects(
      call("yamakan.project.applyBatch", {
        projectId: project.id,
        expectedRevision: project.revision + 1,
        operations: [op],
      }),
      /Track is locked/,
    );
  await assert.rejects(
    call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: project.revision + 1,
      operations: [
        { type: "track.update", trackId: picture, locked: false },
        { type: "clip.setAudio", clipId: ids.title, gainDb: -3 },
      ],
    }),
    /audio clips only/,
  );
  void audio;
  store.close();
});

test("undo and redo are new revisions bound to the head they were made for", async () => {
  const { store, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const batch = (rev: number, clipId: string, start: number) =>
    call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: rev,
      operations: [
        {
          type: "clip.add",
          clipId,
          trackId: picture,
          assetId: null,
          title: "T",
          startTicks: start * F,
          durationTicks: 30 * F,
          sourceStartTicks: 0,
        },
      ],
    });
  const r0 = project.revision;
  const a = await batch(r0, ids.title, 0);
  const b = await batch(a.revision, ids.title2, 30);
  const undone = await call("yamakan.project.undo", {
    projectId: project.id,
    expectedRevision: b.revision,
  });
  assert.equal(undone.revision, b.revision + 1, "undo is a new revision");
  assert.deepEqual(
    undone.clips.map((c: any) => c.id),
    [ids.title],
  );
  const undone2 = await call("yamakan.project.undo", {
    projectId: project.id,
    expectedRevision: undone.revision,
  });
  assert.deepEqual(undone2.clips, []);
  await assert.rejects(
    call("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: undone2.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  const redone = await call("yamakan.project.redo", {
    projectId: project.id,
    expectedRevision: undone2.revision,
  });
  assert.deepEqual(
    redone.clips.map((c: any) => c.id),
    [ids.title],
  );
  // Stale undo (wrong expected revision) conflicts.
  await assert.rejects(
    call("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: undone2.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  // A new edit discards the redo branch.
  const c = await batch(redone.revision, ids.extra, 60);
  await assert.rejects(
    call("yamakan.project.redo", {
      projectId: project.id,
      expectedRevision: c.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  // An edit made another way (whole-project save) ends the undo history.
  const current = await store.load(project.id);
  const saved = await store.save(
    { ...current, name: "Renamed" },
    current.revision,
  );
  await assert.rejects(
    call("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: saved.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  store.close();
});

test("audio gain and fades are rendered, not dropped", async () => {
  const { store, queue, project, audio, call } = await workspace();
  const [picture, sound] = project.tracks.map((t) => t.id);
  // Mean level of the rendered audio over [start, start + seconds).
  const level = (file: string, start: number, seconds: number) => {
    const out = spawnSync(
      mediaTools().ffmpeg,
      [
        "-hide_banner",
        "-ss",
        String(start),
        "-t",
        String(seconds),
        "-i",
        file,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(out.stderr)![1]);
  };
  const render = async (
    audioOps: { gainDb?: number; fadeInTicks?: number },
    key: string,
  ) => {
    const current = await store.load(project.id);
    await call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: current.revision,
      operations: [
        ...(current.clips.length
          ? []
          : [
              {
                type: "clip.add",
                clipId: ids.title,
                trackId: picture,
                assetId: null,
                title: "Level",
                startTicks: 0,
                durationTicks: 60 * F,
                sourceStartTicks: 0,
              },
              {
                type: "clip.add",
                clipId: ids.tone,
                trackId: sound,
                assetId: audio.id,
                title: null,
                startTicks: 0,
                durationTicks: 60 * F,
                sourceStartTicks: 0,
              },
            ]),
        { type: "clip.setAudio", clipId: ids.tone, ...audioOps },
      ],
    });
    const job = await queue.submit(project.id, key);
    let done = queue.status(job.id);
    for (
      let t = 0;
      t < 60000 && !["COMPLETED", "FAILED"].includes(done.state);
      t += 50
    ) {
      await new Promise((r) => setTimeout(r, 50));
      done = queue.status(job.id);
    }
    assert.equal(done.state, "COMPLETED", done.error ?? "");
    return store.file(project.id, ...done.artifact!.split("/"));
  };
  const full = await render({ gainDb: 0, fadeInTicks: 0 }, "full");
  const quiet = await render({ gainDb: -30, fadeInTicks: 0 }, "quiet");
  assert.ok(level(full, 0, 2) - level(quiet, 0, 2) > 25, "gain is applied");
  // Control: without a fade, the opening is as loud as the steady tone.
  assert.ok(Math.abs(level(full, 0, 0.1) - level(full, 1.2, 0.5)) < 3);
  // A one-second fade-in: the opening is far quieter than the steady tone.
  const faded = await render({ gainDb: 0, fadeInTicks: 30 * F }, "fade-in");
  assert.ok(
    level(faded, 1.2, 0.5) - level(faded, 0, 0.1) > 15,
    "the fade-in is applied",
  );
  assert.ok(Math.abs(level(faded, 1.2, 0.5) - level(full, 1.2, 0.5)) < 1);
  await queue.close();
  store.close();
});

test("splitting a clip inside a shot keeps the shot's order; removing it leaves the shot", async () => {
  const { store, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const title = (clipId: string, startTicks: number) => ({
    type: "clip.add" as const,
    clipId,
    trackId: picture,
    assetId: null,
    title: "Shot",
    startTicks,
    durationTicks: 30 * F,
    sourceStartTicks: 0,
  });
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [
      { type: "scene.add", sceneId: ids.scene, name: "Opening" },
      title(ids.title, 0),
      title(ids.extra, 30 * F),
      {
        type: "shot.add",
        sceneId: ids.scene,
        shotId: ids.shot,
        name: "Wide",
        clipIds: [ids.title, ids.extra],
      },
      {
        type: "clip.split",
        clipId: ids.title,
        atTicks: 10 * F,
        newClipId: ids.title2,
      },
    ],
  });
  let p = await store.exportProject(project.id);
  // The second half sits directly after the clip it came from, before the
  // shot's later clip.
  assert.deepEqual(p.scenes[0].shots[0].clipIds, [
    ids.title,
    ids.title2,
    ids.extra,
  ]);
  const halves = [ids.title, ids.title2].map((id) =>
    p.clips.find((c) => c.id === id)!,
  );
  assert.deepEqual(
    halves.map((c) => [c.startTicks, c.durationTicks]),
    [
      [0, 10 * F],
      [10 * F, 20 * F],
    ],
  );
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: p.revision,
    operations: [{ type: "clip.remove", clipId: ids.title }],
  });
  p = await store.exportProject(project.id);
  assert.deepEqual(p.scenes[0].shots[0].clipIds, [ids.title2, ids.extra]);
  store.close();
});

test("a snapped move lands on the nearest clip edge, by start or by end, and is still checked", async () => {
  const { store, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const title = (clipId: string, startTicks: number, frames: number) => ({
    type: "clip.add" as const,
    clipId,
    trackId: picture,
    assetId: null,
    title: "Snap",
    startTicks,
    durationTicks: frames * F,
    sourceStartTicks: 0,
  });
  const apply = async (operations: Operation[]) => {
    const head = await store.exportProject(project.id);
    await call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: head.revision,
      operations,
    });
    return store.exportProject(project.id);
  };
  // a: [0, 30) and b: [100, 130) in frames; the moving clip is 20 frames.
  await apply([
    title(ids.title, 0, 30),
    title(ids.title2, 100 * F, 30),
    title(ids.extra, 50 * F, 20),
  ]);
  const at = (p: Awaited<ReturnType<typeof apply>>) =>
    p.clips.find((c) => c.id === ids.extra)!.startTicks / F;
  // Start 33 is 3 frames from a's end: it snaps to 30.
  let p = await apply([
    {
      type: "clip.move",
      clipId: ids.extra,
      startTicks: 33 * F,
      snapTicks: 5 * F,
    },
  ]);
  assert.equal(at(p), 30);
  // Start 78 puts the end at 98, 2 frames from b's start: the end snaps.
  p = await apply([
    {
      type: "clip.move",
      clipId: ids.extra,
      startTicks: 78 * F,
      snapTicks: 5 * F,
    },
  ]);
  assert.equal(at(p), 80);
  // Nothing within reach: the move is exact.
  p = await apply([
    {
      type: "clip.move",
      clipId: ids.extra,
      startTicks: 60 * F,
      snapTicks: 5 * F,
    },
  ]);
  assert.equal(at(p), 60);
  // A snap that would overlap is refused like any other placement.
  await assert.rejects(
    apply([
      {
        type: "clip.move",
        clipId: ids.extra,
        startTicks: 12 * F,
        snapTicks: 15 * F,
      },
    ]),
    /overlap/,
  );
  store.close();
});
