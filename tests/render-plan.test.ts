import test from "node:test";
import assert from "node:assert/strict";
import { fromEditView } from "../core/canonical.ts";
import { createProject, ProjectSchema } from "../core/project.ts";
import type { Project } from "../core/project.ts";
import { compilePlan, RENDER_PLAN_FORMAT } from "../core/render/plan.ts";
import { titleFonts } from "../core/render/fonts.ts";
import { CommandError } from "../core/command/errors.ts";

const SNAPSHOT = "c".repeat(64);
const F = 23_520_000;

// Built once: createProject draws random ids, and every comparison needs the
// same project.
const BASE = build();
const view = (): Project => structuredClone(BASE);
function build(): Project {
  const p = createProject("Plan");
  const video = "11111111-1111-4111-8111-111111111111";
  const audio = "22222222-2222-4222-8222-222222222222";
  p.assets.push(
    {
      id: video,
      name: "shot.mp4",
      kind: "video",
      hash: "a".repeat(64),
      extension: "mp4",
      bytes: 1000,
      durationFrames: 300,
      width: 1280,
      height: 720,
    },
    {
      id: audio,
      name: "tone.wav",
      kind: "audio",
      hash: "b".repeat(64),
      extension: "wav",
      bytes: 500,
      durationFrames: 300,
      width: 0,
      height: 0,
    },
  );
  p.clips.push(
    {
      id: "33333333-3333-4333-8333-333333333333",
      trackId: p.tracks[0].id,
      assetId: video,
      startFrame: 0,
      durationFrames: 60,
      sourceFrame: 15,
      title: null,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      trackId: p.tracks[0].id,
      assetId: null,
      startFrame: 60,
      durationFrames: 30,
      sourceFrame: 0,
      title: "مرحبا · Hello",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      trackId: p.tracks[1].id,
      assetId: audio,
      startFrame: 0,
      durationFrames: 120,
      sourceFrame: 0,
      title: null,
      gainDb: -6,
      fadeInFrames: 15,
    },
  );
  return ProjectSchema.parse({ ...p, revision: 4 });
}

test("a plan is deterministic, versioned and free of host paths", async () => {
  const fonts = await titleFonts();
  const a = compilePlan(fromEditView(view()), SNAPSHOT, fonts);
  const b = compilePlan(fromEditView(view()), SNAPSHOT, fonts);
  assert.deepEqual(a, b);
  assert.equal(a.plan.format, RENDER_PLAN_FORMAT);
  assert.equal(a.plan.revision, 4);
  assert.equal(a.plan.durationTicks, 120 * F);
  assert.deepEqual(
    a.plan.layers.map((l) => [
      l.kind,
      l.startTicks / F,
      l.sourceStartTicks / F,
    ]),
    [["video", 0, 15]],
  );
  assert.deepEqual(
    a.plan.audio.map((x) => [x.gainDb, x.fadeInTicks / F, x.assetSha256[0]]),
    [[-6, 15, "b"]],
  );
  assert.equal(a.plan.titles!.cues[0].text, "مرحبا · Hello");
  assert.equal(a.plan.titles!.sha256.length, 64);
  assert.deepEqual(
    a.plan.fonts.map((f) => f.sha256),
    fonts.map((f) => f.sha256),
  );
  assert.ok(a.ass?.includes("Dialogue: 0,0:00:01.99,0:00:02.99,Default"));
  // No absolute paths, drive letters or URLs anywhere in the plan.
  assert.doesNotMatch(JSON.stringify(a.plan), /[a-z]:\\|\/\/|\\\\/i);
});

test("the plan hash changes with every input that changes the picture or sound", async () => {
  const fonts = await titleFonts();
  const base = compilePlan(fromEditView(view()), SNAPSHOT, fonts).plan.planHash;
  const changed = (edit: (p: Project) => void, snapshot = SNAPSHOT) => {
    const p = view();
    edit(p);
    return compilePlan(fromEditView(ProjectSchema.parse(p)), snapshot, fonts)
      .plan.planHash;
  };
  for (const [name, hash] of [
    ["snapshot", changed(() => {}, "d".repeat(64))],
    ["title text", changed((p) => (p.clips[1].title = "Other"))],
    ["gain", changed((p) => (p.clips[2].gainDb = -7))],
    ["source offset", changed((p) => (p.clips[0].sourceFrame = 16))],
    ["mute", changed((p) => (p.tracks[1].muted = true))],
    ["size", changed((p) => ((p.width = 640), (p.height = 360)))],
  ] as const)
    assert.notEqual(hash, base, name);
});

test("muted tracks are left out and solo keeps only soloed tracks of a kind", async () => {
  const fonts = await titleFonts();
  const muted = view();
  muted.tracks[1].muted = true;
  assert.deepEqual(
    compilePlan(fromEditView(muted), SNAPSHOT, fonts).plan.audio,
    [],
  );
  const solo = view();
  solo.tracks.push({
    id: "66666666-6666-4666-8666-666666666666",
    name: "Solo",
    kind: "video",
    muted: false,
    locked: false,
    solo: true,
  });
  // The only soloed picture track is empty: no picture or title remains.
  assert.throws(
    () => compilePlan(fromEditView(solo), SNAPSHOT, fonts),
    (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
  );
});

test("plans refuse invalid snapshot hashes and untitled, pictureless timelines", async () => {
  const fonts = await titleFonts();
  assert.throws(
    () => compilePlan(fromEditView(view()), "nope", fonts),
    CommandError,
  );
  const empty = view();
  empty.clips = empty.clips.filter(
    (c) =>
      c.assetId !== null &&
      c.title === null &&
      c.trackId === empty.tracks[1].id,
  );
  assert.throws(
    () => compilePlan(fromEditView(empty), SNAPSHOT, fonts),
    /no active picture or title/,
  );
});
