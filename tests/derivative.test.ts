import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { probe } from "../core/media.ts";
import { mediaTools } from "../core/process/workers.ts";

async function vfrWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-vfr-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Variable frame rate");
  const vfr = path.join(root, "vfr.mp4");
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
      "testsrc=size=320x240:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=2",
      "-vf",
      "select='not(mod(n\\,3))+eq(n\\,1)'",
      "-fps_mode",
      "vfr",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      vfr,
    ],
    { windowsHide: true },
  );
  const bytes = await readFile(vfr);
  const staged = await store.stageAsset(project.id, "vfr.mp4", bytes);
  assert.equal(staged.probe.variableFrameRate, true);
  return { root, store, project, staged };
}
async function settled(supervisor: JobSupervisor, jobId: string) {
  for (let t = 0; t < 120000; t += 50) {
    const job = supervisor.status(jobId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not settle");
}

test("a VFR source becomes an attached constant-rate derivative with recorded lineage", async () => {
  const { store, project, staged } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  assert.equal(
    (await store.load(project.id)).assets.length,
    0,
    "not editable before conversion",
  );
  const job = await supervisor.submitDerivative(project.id, staged);
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  assert.equal(done.artifact, `asset:${staged.asset.id}`);
  const [asset] = (await store.load(project.id)).assets;
  assert.equal(
    asset.id,
    staged.asset.id,
    "the logical asset keeps its identity",
  );
  assert.notEqual(
    asset.hash,
    staged.asset.hash,
    "it now selects the derivative",
  );
  const converted = await probe(await store.objectFile(project.id, asset));
  assert.equal(converted.variableFrameRate, false);
  assert.deepEqual(converted.frameRate, { num: 30, den: 1 });
  assert.ok(converted.hasAudio);
  // The original is retained as its own version; the derivative records lineage.
  const original = store.assetVersion(staged.asset.id)!;
  assert.deepEqual(
    [original.digest, original.probe.variableFrameRate],
    [staged.asset.hash, true],
  );
  const versions = store.read((db) =>
    db
      .prepare(
        "SELECT version_id, digest, probe FROM asset_versions WHERE project_id = ?",
      )
      .all(project.id),
  ) as { version_id: string; digest: string; probe: string }[];
  const derived = versions.find((v) => v.digest === asset.hash)!;
  assert.deepEqual(JSON.parse(derived.probe).derivedFrom, {
    versionId: staged.asset.id,
    digest: staged.asset.hash,
  });
  // The converted asset renders.
  const current = await store.load(project.id);
  const edited = await store.save(
    {
      ...current,
      width: 320,
      height: 240,
      clips: [
        {
          id: crypto.randomUUID(),
          trackId: current.tracks[0].id,
          assetId: asset.id,
          startFrame: 0,
          durationFrames: Math.min(30, asset.durationFrames),
          sourceFrame: 0,
          title: null,
        },
      ],
    },
    current.revision,
  );
  const exported = await supervisor.submit(edited.id, "vfr-export");
  assert.equal((await settled(supervisor, exported.id)).state, "COMPLETED");
  await supervisor.close();
  store.close();
});

test("a cancelled conversion attaches nothing", async () => {
  const { store, project, staged } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store, {
    fault: (point, jobId) => {
      if (point === "before-succeed") supervisor.cancel(jobId);
    },
  });
  await supervisor.start();
  const job = await supervisor.submitDerivative(project.id, staged);
  assert.equal((await settled(supervisor, job.id)).state, "CANCELLED");
  assert.equal((await store.load(project.id)).assets.length, 0);
  await supervisor.close();
  store.close();
});
