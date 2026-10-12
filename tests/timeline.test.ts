import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { execute, Scopes } from "../core/command/registry.ts";
import { CommandError } from "../core/command/errors.ts";
import { mediaTools } from "../core/process/workers.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";
import type { Operation } from "../core/timeline/operations.ts";
import {
  FRAME_TICKS,
  applyLocal,
  deleteClip,
  splitClip,
  updateClips,
} from "../src/edit-ops.ts";

const F = 23_520_000; // flicks per 30 fps frame
const ids = {
  scene: "11111111-1111-4111-8111-111111111111",
  shot: "22222222-2222-4222-8222-222222222222",
  title: "33333333-3333-4333-8333-333333333333",
  title2: "44444444-4444-4444-8444-444444444444",
  tone: "55555555-5555-4555-8555-555555555555",
  extra: "66666666-6666-4666-8666-666666666666",
};

// Every test folder is removed when the file's tests finish, after the
// stores and queues opened in it close (Windows cannot delete them open).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-timeline-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
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
  handles.push(queue);
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
  // The same edits through the editor's own path (src/edit-ops.ts, one edit
  // at a time on its local edit view, then a whole-project save) give the
  // same canonical project. The second workspace's generated identifiers
  // are mapped onto the first's (a deterministic replay mapping); nothing
  // else is removed or normalised before comparing every field.
  const second = await workspace();
  let view = await second.store.load(second.project.id);
  for (const op of tenOperations(view, second.audio.id))
    view =
      op.type === "clip.split"
        ? splitClip(
            view,
            op.clipId,
            op.atTicks / FRAME_TICKS / 30,
            op.newClipId,
          )
        : applyLocal(view, [op]);
  await second.store.save(view, view.revision);
  const viaUi = await second.store.exportProject(second.project.id);
  const mapping = new Map<string, string>([
    [second.project.id, project.id],
    [second.audio.id, audio.id],
    ...second.project.tracks.map(
      (t, i) => [t.id, project.tracks[i].id] as [string, string],
    ),
  ]);
  let replayed = JSON.stringify(viaUi);
  for (const [from, to] of mapping) replayed = replayed.replaceAll(from, to);
  assert.equal(replayed, JSON.stringify(p), "identical canonical bytes");
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
    audioOps: { gainDb?: number; fadeInTicks?: number; fadeOutTicks?: number },
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
  // A one-second fade-out: the closing tenth is far quieter than the middle.
  const out = await render(
    { gainDb: 0, fadeInTicks: 0, fadeOutTicks: 30 * F },
    "fade-out",
  );
  assert.ok(level(full, 1.85, 0.1) - level(full, 0.5, 0.5) > -3, "control");
  assert.ok(
    level(out, 0.5, 0.5) - level(out, 1.88, 0.1) > 15,
    "the fade-out is applied",
  );
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

test("the editor's own split, delete and trim keep projects with shots and fades saveable", async () => {
  const { store, project, audio, call } = await workspace();
  const [, sound] = project.tracks.map((t) => t.id);
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [
      { type: "scene.add", sceneId: ids.scene, name: "Opening" },
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
      {
        type: "clip.setAudio",
        clipId: ids.tone,
        fadeInTicks: 20 * F,
        fadeOutTicks: 20 * F,
      },
      {
        type: "shot.add",
        sceneId: ids.scene,
        shotId: ids.shot,
        name: "Wide",
        clipIds: [ids.tone],
      },
    ],
  });
  let view = await store.load(project.id);
  // Split in the middle: both halves keep valid fades and join the shot.
  view = splitClip(view, ids.tone, 1, ids.extra);
  const halves = [ids.tone, ids.extra].map((id) =>
    view.clips.find((c) => c.id === id)!,
  );
  assert.deepEqual(
    // The edit view omits zero fades.
    halves.map((c) => [
      c.durationFrames,
      c.fadeInFrames ?? 0,
      c.fadeOutFrames ?? 0,
    ]),
    [
      [30, 20, 0],
      [30, 0, 20],
    ],
  );
  assert.deepEqual(view.scenes?.[0].shots?.[0].clipIds, [ids.tone, ids.extra]);
  view = await store.save(view, view.revision);
  // Trim the second half below its fade: the fade is clamped.
  const second = view.clips.find((c) => c.id === ids.extra)!;
  view = updateClips(view, [
    {
      id: ids.extra,
      mediaId: audio.id,
      trackId: second.trackId,
      start: 1,
      end: 1.5,
      duration: 0.5,
      speed: 1,
      sourceIn: 1,
      effect: null,
    },
  ]);
  const trimmed = view.clips.find((c) => c.id === ids.extra)!;
  assert.deepEqual([trimmed.durationFrames, trimmed.fadeOutFrames], [15, 15]);
  view = await store.save(view, view.revision);
  // Delete the first half: it leaves the shot, and the save succeeds.
  view = deleteClip(view, ids.tone);
  assert.deepEqual(view.scenes?.[0].shots?.[0].clipIds, [ids.extra]);
  view = await store.save(view, view.revision);
  assert.equal(view.clips.length, 1);
  store.close();
});

test("still images have no source offset: they extend left and split cleanly", async () => {
  const { root, store, project, call } = await workspace();
  const png = path.join(root, "still.png");
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
      "color=c=red:s=64x36:d=1",
      "-frames:v",
      "1",
      png,
    ],
    { windowsHide: true },
  );
  const image = (
    await store.importAsset(project.id, "still.png", await readFile(png))
  ).asset;
  const [picture] = (await store.load(project.id)).tracks.map((t) => t.id);
  const head = await store.exportProject(project.id);
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: head.revision,
    operations: [
      {
        type: "clip.add",
        clipId: ids.title,
        trackId: picture,
        assetId: image.id,
        title: null,
        startTicks: 30 * F,
        durationTicks: 30 * F,
        sourceStartTicks: 0,
      },
      { type: "clip.trim", clipId: ids.title, startTicks: 0 },
      {
        type: "clip.split",
        clipId: ids.title,
        atTicks: 20 * F,
        newClipId: ids.title2,
      },
    ],
  });
  const p = await store.exportProject(project.id);
  const clip = (id: string) => p.clips.find((c) => c.id === id)!;
  assert.deepEqual(
    [ids.title, ids.title2].map((id) => [
      clip(id).startTicks / F,
      clip(id).durationTicks / F,
      clip(id).sourceStartTicks,
    ]),
    [
      [0, 20, 0],
      [20, 40, 0],
    ],
  );
  store.close();
});

test("undo never rewinds another writer's batch", async () => {
  const { store, queue, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const as =
    (id: "browser-ui" | "local-client") =>
    (operation: string, parameters: unknown) =>
      execute(
        { store, queue, principal: { id, scopes: new Set(Scopes) } },
        operation,
        parameters,
      ).then((r) => r.result as any);
  const agent = as("browser-ui");
  const title = (clipId: string, startTicks: number) => ({
    type: "clip.add" as const,
    clipId,
    trackId: picture,
    assetId: null,
    title: "Mine",
    startTicks,
    durationTicks: 10 * F,
    sourceStartTicks: 0,
  });
  const first = await agent("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [title(ids.title, 0)],
  });
  const second = await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: first.revision,
    operations: [title(ids.title2, 20 * F)],
  });
  await assert.rejects(
    agent("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: second.revision,
    }),
    (e: unknown) =>
      e instanceof CommandError &&
      e.code === "REVISION_CONFLICT" &&
      /another client/.test(e.message),
  );
  // The writer of the last batch may undo it.
  const undone = await call("yamakan.project.undo", {
    projectId: project.id,
    expectedRevision: second.revision,
  });
  const p = await store.exportProject(project.id);
  assert.equal(p.revision, undone.revision);
  assert.deepEqual(
    p.clips.map((c) => c.id),
    [ids.title],
  );
  store.close();
});

test("operations never reuse an identifier, and out-of-range time is a validation error", async () => {
  const { store, project, call } = await workspace();
  const [picture, sound] = project.tracks.map((t) => t.id);
  const add = (clipId: string, trackId: string, startTicks: number) => ({
    type: "clip.add" as const,
    clipId,
    trackId,
    assetId: null,
    title: trackId === picture ? "X" : null,
    startTicks,
    durationTicks: 10 * F,
    sourceStartTicks: 0,
  });
  const before = await store.exportProject(project.id);
  for (const operations of [
    [add(ids.title, picture, 0), add(ids.title, picture, 20 * F)],
    [
      add(ids.title, picture, 0),
      {
        type: "clip.split",
        clipId: ids.title,
        atTicks: 5 * F,
        newClipId: ids.title,
      },
    ],
    [{ type: "track.add", trackId: sound, name: "Again", kind: "audio" }],
    [{ type: "scene.add", sceneId: project.id, name: "Clash" }],
  ])
    await assert.rejects(
      call("yamakan.project.applyBatch", {
        projectId: project.id,
        expectedRevision: before.revision,
        operations,
      }),
      (e: unknown) =>
        e instanceof CommandError &&
        e.code === "VALIDATION" &&
        /already in use/.test(e.message),
    );
  await assert.rejects(
    call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: before.revision,
      operations: [
        {
          ...add(ids.title, picture, 0),
          title: "Far",
          sourceStartTicks: Number.MAX_SAFE_INTEGER,
          durationTicks: 1,
        },
      ],
    }),
    (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
  );
  assert.equal(
    (await store.exportProject(project.id)).revision,
    before.revision,
  );
  store.close();
});

test("a snap that would overlap falls back to the next valid placement", async () => {
  const { store, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const head = await store.exportProject(project.id);
  const second = crypto.randomUUID();
  const add = (
    clipId: string,
    trackId: string,
    start: number,
    frames: number,
  ) => ({
    type: "clip.add" as const,
    clipId,
    trackId,
    assetId: null,
    title: "S",
    startTicks: start * F,
    durationTicks: frames * F,
    sourceStartTicks: 0,
  });
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: head.revision,
    operations: [
      { type: "track.add", trackId: second, name: "Upper", kind: "video" },
      add(ids.extra, picture, 30, 10),
      add(ids.title, picture, 13, 5),
      add(ids.title2, second, 4, 5),
    ],
  });
  const now = await store.exportProject(project.id);
  // Dropping at 1 with a 3-frame snap: the nearest snap (start to 4) would
  // overlap [13, 18); the end snapping to 13 (start 3) fits and is taken.
  await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: now.revision,
    operations: [
      {
        type: "clip.move",
        clipId: ids.extra,
        startTicks: 1 * F,
        snapTicks: 3 * F,
      },
    ],
  });
  const p = await store.exportProject(project.id);
  assert.equal(p.clips.find((c) => c.id === ids.extra)!.startTicks / F, 3);
  store.close();
});

test("scene removal takes its shots; moves keep track kinds; redo ends at another commit", async () => {
  const { store, project, audio, call } = await workspace();
  const [picture, sound] = project.tracks.map((t) => t.id);
  const applied = await call("yamakan.project.applyBatch", {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [
      { type: "scene.add", sceneId: ids.scene, name: "Gone" },
      {
        type: "clip.add",
        clipId: ids.tone,
        trackId: sound,
        assetId: audio.id,
        title: null,
        startTicks: 0,
        durationTicks: 30 * F,
        sourceStartTicks: 0,
      },
      {
        type: "shot.add",
        sceneId: ids.scene,
        shotId: ids.shot,
        name: "S",
        clipIds: [ids.tone],
      },
      { type: "scene.remove", sceneId: ids.scene },
    ],
  });
  let p = await store.exportProject(project.id);
  assert.deepEqual(p.scenes, []);
  assert.equal(p.clips.length, 1, "the clip stays; only its grouping went");
  await assert.rejects(
    call("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: applied.revision,
      operations: [
        {
          type: "clip.move",
          clipId: ids.tone,
          trackId: picture,
          startTicks: 0,
        },
      ],
    }),
    /same kind/,
  );
  // Undo, then a whole-project save: the redo is gone.
  const undone = await call("yamakan.project.undo", {
    projectId: project.id,
    expectedRevision: applied.revision,
  });
  const view = await store.load(project.id);
  const saved = await store.save({ ...view, name: "Renamed" }, undone.revision);
  await assert.rejects(
    call("yamakan.project.redo", {
      projectId: project.id,
      expectedRevision: saved.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  p = await store.exportProject(project.id);
  assert.equal(p.name, "Renamed");
  store.close();
});

test("low disk refuses new revisions but still replays a committed request; restore needs only its snapshot", async () => {
  const { root, store, project, call } = await workspace();
  const [picture] = project.tracks.map((t) => t.id);
  const op = {
    type: "clip.add" as const,
    clipId: ids.title,
    trackId: picture,
    assetId: null,
    title: "Kept",
    startTicks: 0,
    durationTicks: 10 * F,
    sourceStartTicks: 0,
  };
  const request = {
    projectId: project.id,
    expectedRevision: project.revision,
    operations: [op],
  };
  const committed = await call("yamakan.project.applyBatch", request, "disk-1");
  store.close();
  let free = 0;
  const low = new ProjectStore(root, { freeBytes: () => free });
  handles.push(low);
  await low.initialize();
  const lowQueue = new JobSupervisor(low);
  handles.push(lowQueue);
  const ctx = {
    store: low,
    queue: lowQueue,
    principal: { id: "local-client" as const, scopes: new Set(Scopes) },
  };
  const lowCall = (
    operation: string,
    parameters: unknown,
    requestId?: string,
  ) =>
    execute({ ...ctx, requestId }, operation, parameters).then(
      (r) => r.result as any,
    );
  // The retry of the committed request returns its original result.
  assert.equal(
    (await lowCall("yamakan.project.applyBatch", request, "disk-1")).revision,
    committed.revision,
  );
  await assert.rejects(
    lowCall("yamakan.project.applyBatch", {
      projectId: project.id,
      expectedRevision: committed.revision,
      operations: [{ type: "clip.setTitle", clipId: ids.title, title: "New" }],
    }),
    (e: unknown) => e instanceof CommandError && e.code === "LIMIT_EXCEEDED",
  );
  // With room for one snapshot but not the import reserve, only restore runs.
  free = RESOURCE_POLICY.enforced.snapshotBytes;
  const history = await low.history(project.id);
  await assert.rejects(
    lowCall("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: committed.revision,
    }),
    (e: unknown) => e instanceof CommandError && e.code === "LIMIT_EXCEEDED",
  );
  const restored = await low.restore(
    project.id,
    project.revision,
    history.headFingerprint,
  );
  assert.equal(restored.revision, committed.revision + 1);
  assert.equal(restored.clips.length, 0);
  low.close();
});

test("the editor's drag-trim of a still image matches the reducer", async () => {
  const { root, store, project } = await workspace();
  const png = path.join(root, "still.png");
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
      "color=c=blue:s=64x36:d=1",
      "-frames:v",
      "1",
      png,
    ],
    { windowsHide: true },
  );
  const image = (
    await store.importAsset(project.id, "still.png", await readFile(png))
  ).asset;
  let view = await store.load(project.id);
  const picture = view.tracks[0].id;
  view = applyLocal(view, [
    {
      type: "clip.add",
      clipId: ids.title,
      trackId: picture,
      assetId: image.id,
      title: null,
      startTicks: 30 * F,
      durationTicks: 30 * F,
      sourceStartTicks: 0,
    },
  ]);
  // Left-trim from 30 to 45 frames, as the timeline reports it (sourceIn 0.5 s).
  const viaEditor = updateClips(view, [
    {
      id: ids.title,
      mediaId: image.id,
      trackId: picture,
      start: 1.5,
      end: 2,
      duration: 0.5,
      speed: 1,
      sourceIn: 0.5,
      effect: null,
    },
  ]);
  const viaReducer = applyLocal(view, [
    { type: "clip.trim", clipId: ids.title, startTicks: 45 * F },
  ]);
  assert.deepEqual(viaEditor, viaReducer);
  assert.equal(viaEditor.clips[0].sourceFrame, 0);
  store.close();
});
