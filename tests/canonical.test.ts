import test from "node:test";
import assert from "node:assert/strict";
import {
  CanonicalProjectSchema,
  FORMAT,
  fromEditView,
  inspectFormat,
  parseCanonical,
  toEditView,
} from "../core/canonical.ts";
import { createProject, ProjectSchema } from "../core/project.ts";
import type { Project } from "../core/project.ts";
import { CommandError } from "../core/command/errors.ts";

function richView(): Project {
  const p = createProject("Round trip");
  const image = crypto.randomUUID(),
    audio = crypto.randomUUID();
  p.assets.push(
    {
      id: image,
      name: "still.png",
      kind: "image",
      hash: "a".repeat(64),
      extension: "png",
      bytes: 100,
      durationFrames: 0,
      width: 640,
      height: 360,
    },
    {
      id: audio,
      name: "tone.wav",
      kind: "audio",
      hash: "b".repeat(64),
      extension: "wav",
      bytes: 200,
      durationFrames: 300,
      width: 0,
      height: 0,
    },
  );
  p.scenes.push({
    id: crypto.randomUUID(),
    name: "مشهد ١ · Opening",
    referenceAssetId: image,
    camera: { focalLengthMm: 85, shotScale: "close", movement: "dolly" },
  });
  p.tracks[0].solo = true;
  p.clips.push(
    {
      id: crypto.randomUUID(),
      trackId: p.tracks[0].id,
      assetId: image,
      startFrame: 0,
      durationFrames: 45,
      sourceFrame: 0,
      title: null,
    },
    {
      id: crypto.randomUUID(),
      trackId: p.tracks[0].id,
      assetId: null,
      startFrame: 45,
      durationFrames: 30,
      sourceFrame: 0,
      title: "عنوان · Title ١٢٣",
    },
    {
      id: crypto.randomUUID(),
      trackId: p.tracks[1].id,
      assetId: audio,
      startFrame: 10,
      durationFrames: 200,
      sourceFrame: 17,
      title: null,
    },
  );
  return ProjectSchema.parse({ ...p, revision: 7 });
}

test("the 30 fps editing shape round-trips losslessly through canonical v1", () => {
  const view = richView();
  const canonical = fromEditView(view, "ar");
  assert.equal(canonical.format, FORMAT);
  assert.equal(canonical.formatVersion, 2);
  assert.equal(canonical.language, "ar");
  assert.deepEqual(canonical.output.fps, { num: 30, den: 1 });
  // One 30 fps frame is exactly 23,520,000 flicks.
  const audioClip = canonical.clips[2];
  assert.deepEqual(
    [audioClip.startTicks, audioClip.durationTicks, audioClip.sourceStartTicks],
    [10 * 23_520_000, 200 * 23_520_000, 17 * 23_520_000],
  );
  assert.deepEqual(toEditView(canonical), view);
});

test("canonical values the 30 fps editor cannot hold are refused, not dropped", () => {
  const canonical = fromEditView(richView());
  const misaligned = structuredClone(canonical);
  misaligned.clips[0].startTicks += 1;
  assert.throws(
    () => toEditView(misaligned),
    (e: unknown) =>
      e instanceof CommandError && e.code === "CAPABILITY_UNAVAILABLE",
  );
  const ntsc = {
    ...structuredClone(canonical),
    output: { ...canonical.output, fps: { num: 30000, den: 1001 } },
  };
  assert.throws(() => toEditView(ntsc), /only 30 fps/);
  const timed = structuredClone(canonical);
  timed.assets[1].timebase = { num: 1, den: 48000 };
  assert.throws(() => toEditView(timed), /time bases/);
});

test("canonical validation enforces refs, safe integers and strict keys", () => {
  const base = fromEditView(richView());
  const cases: [string, (p: any) => void][] = [
    ["duplicate id", (p) => (p.clips[1].id = p.clips[0].id)],
    ["missing track", (p) => (p.clips[0].trackId = crypto.randomUUID())],
    [
      "unsafe ticks",
      (p) => (p.clips[0].startTicks = Number.MAX_SAFE_INTEGER + 2),
    ],
    ["fractional ticks", (p) => (p.clips[0].durationTicks = 1.5)],
    ["negative ticks", (p) => (p.clips[0].sourceStartTicks = -1)],
    [
      "beyond source",
      (p) => (p.clips[2].sourceStartTicks = p.assets[1].durationTicks),
    ],
    ["title with offset", (p) => (p.clips[1].sourceStartTicks = 1)],
    ["unreduced fps", (p) => (p.output.fps = { num: 60, den: 2 })],
    ["unknown key", (p) => (p.extra = true)],
    ["host path", (p) => (p.assets[0].path = "C:\\Users\\x\\still.png")],
    [
      "prototype key",
      (p) =>
        Object.defineProperty(p, "__proto__", {
          value: { polluted: true },
          enumerable: true,
        }),
    ],
  ];
  for (const [label, mutate] of cases) {
    const p = structuredClone(base) as any;
    mutate(p);
    assert.equal(CanonicalProjectSchema.safeParse(p).success, false, label);
  }
});

test("newer formats can be inspected but not parsed for editing", () => {
  const newer = {
    ...fromEditView(richView()),
    formatVersion: 3,
    futureField: { x: 1 },
  };
  assert.deepEqual(inspectFormat(newer), {
    format: FORMAT,
    formatVersion: 3,
    supported: false,
  });
  assert.throws(
    () => parseCanonical(newer),
    (e: unknown) => e instanceof CommandError && e.code === "RECOVERY_REQUIRED",
  );
  assert.throws(
    () => parseCanonical({ schemaVersion: 1, id: "legacy" }),
    (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
  );
  assert.deepEqual(inspectFormat("not an object"), {
    format: null,
    formatVersion: null,
    supported: false,
  });
});

test("a stored v1 canonical snapshot upgrades to v2 losslessly; v1 with v2 fields is refused", () => {
  const v2 = fromEditView(richView(), "ar");
  // The same project as v1 stored it: no gain, fades or shots.
  const v1 = JSON.parse(JSON.stringify(v2));
  v1.formatVersion = 1;
  for (const c of v1.clips) {
    delete c.gainDb;
    delete c.fadeInTicks;
    delete c.fadeOutTicks;
  }
  for (const s of v1.scenes) delete s.shots;
  assert.deepEqual(parseCanonical(v1), v2);
  for (const tamper of [
    (x: any) => (x.clips[2].gainDb = -6),
    (x: any) => (x.scenes[0].shots = []),
  ]) {
    const claimed = JSON.parse(JSON.stringify(v1));
    tamper(claimed);
    assert.throws(
      () => parseCanonical(claimed),
      (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
    );
  }
});
