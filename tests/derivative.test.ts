import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
import { probe } from "../core/media.ts";
import { mediaTools } from "../core/process/workers.ts";

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { windowsHide: true },
  );

// Every test folder is removed when the file's tests finish, after the
// stores and queues opened in it close (Windows cannot delete them open).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});

// A two-second variable-frame-rate clip with audio, optionally odd-sized or
// carrying a display rotation (as phone video does).
async function vfrWorkspace(
  options: { size?: string; rotate?: number; pixFmt?: string } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-vfr-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  await store.initialize();
  const project = await store.create("Variable frame rate");
  const vfr = path.join(root, "vfr.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${options.size ?? "320x240"}:rate=30:duration=2`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=2",
    "-vf",
    "select='not(mod(n\\,3))+eq(n\\,1)'",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    options.pixFmt ?? "yuv420p",
    "-shortest",
    vfr,
  ]);
  let source = vfr;
  if (options.rotate !== undefined) {
    source = path.join(root, "rotated.mp4");
    ffmpeg([
      "-display_rotation",
      String(options.rotate),
      "-i",
      vfr,
      "-c",
      "copy",
      source,
    ]);
  }
  const bytes = await readFile(source);
  const staged = await store.stageAsset(project.id, "vfr.mp4", bytes);
  assert.equal(staged.probe.variableFrameRate, true);
  return { root, store, project, staged, bytes };
}
async function settled(supervisor: JobSupervisor, jobId: string) {
  for (let t = 0; t < 120000; t += 50) {
    const job = supervisor.status(jobId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not settle");
}
// Content objects on disk, and the rows that register them.
async function objectFiles(store: ProjectStore, projectId: string) {
  const dir = await store.file(projectId, "objects", "sha256");
  const out: string[] = [];
  for (const prefix of await readdir(dir).catch(() => []))
    for (const name of await readdir(path.join(dir, prefix)))
      if (/^[0-9a-f]{64}$/.test(name)) out.push(name);
  return out.sort();
}
const objectRows = (store: ProjectStore, projectId: string) =>
  (
    store.read((db) =>
      db
        .prepare(
          "SELECT digest FROM asset_objects WHERE project_id = ? ORDER BY digest",
        )
        .all(projectId),
    ) as { digest: string }[]
  ).map((r) => r.digest);

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
  const [asset] = (await store.load(project.id)).assets;
  assert.equal(done.artifact, `asset:${asset.id}`);
  // The project gains the derivative as its own version: an asset id is
  // always the version bound to its bytes and probe.
  assert.notEqual(asset.id, staged.asset.id);
  assert.notEqual(asset.hash, staged.asset.hash);
  const version = store.assetVersion(asset.id)!;
  assert.equal(version.digest, asset.hash);
  assert.equal(version.probe.variableFrameRate, false);
  assert.deepEqual(version.probe.derivedFrom, {
    versionId: staged.asset.id,
    digest: staged.asset.hash,
  });
  const converted = await probe(await store.objectFile(project.id, asset));
  assert.equal(converted.variableFrameRate, false);
  assert.deepEqual(converted.frameRate, { num: 30, den: 1 });
  assert.ok(converted.hasAudio);
  // The original is retained as its own version.
  const original = store.assetVersion(staged.asset.id)!;
  assert.deepEqual(
    [original.digest, original.probe.variableFrameRate],
    [staged.asset.hash, true],
  );
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

test("a cancelled conversion attaches nothing and releases the staged original and its copy", async () => {
  const { store, project, staged } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store, {
    fault: (point, jobId) => {
      if (point === "before-succeed") supervisor.cancel(jobId);
    },
  });
  await supervisor.start();
  assert.deepEqual(await objectFiles(store, project.id), [staged.asset.hash]);
  const job = await supervisor.submitDerivative(project.id, staged);
  assert.equal((await settled(supervisor, job.id)).state, "CANCELLED");
  await supervisor.close();
  assert.equal((await store.load(project.id)).assets.length, 0);
  assert.equal(store.assetVersion(staged.asset.id), null);
  assert.deepEqual(objectRows(store, project.id), []);
  assert.deepEqual(
    await objectFiles(store, project.id),
    [],
    "neither the original nor the converted copy is left on disk",
  );
  store.close();
});

test("cancelling a queued conversion releases its staged original", async () => {
  const { store, project, staged, bytes } = await vfrWorkspace();
  // The first job is held after its claim, so the second stays queued.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let claims = 0;
  const supervisor = new JobSupervisor(store, {
    fault: (point) =>
      point === "after-claim" && claims++ === 0 ? held : undefined,
  });
  await supervisor.start();
  const first = (await supervisor.submitDerivative(project.id, staged)).id;
  const other = await store.stageAsset(
    project.id,
    "other.mp4",
    Buffer.concat([bytes]),
  );
  const queued = await supervisor.submitDerivative(project.id, other);
  assert.equal(supervisor.status(queued.id).state, "QUEUED");
  assert.equal(supervisor.cancel(queued.id).state, "CANCELLED");
  for (let t = 0; t < 5000 && store.assetVersion(other.asset.id); t += 50)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.assetVersion(other.asset.id), null);
  // Both uploads share bytes, so the first job's version keeps the object.
  assert.deepEqual(await objectFiles(store, project.id), [staged.asset.hash]);
  release();
  assert.equal((await settled(supervisor, first)).state, "COMPLETED");
  await supervisor.close();
  store.close();
});

test("uploading the same VFR file again converts and attaches it again", async () => {
  const { store, project, staged, bytes } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const first = await supervisor.submitDerivative(project.id, staged);
  assert.equal((await settled(supervisor, first.id)).state, "COMPLETED");
  const again = await store.stageAsset(project.id, "vfr.mp4", bytes);
  const second = await supervisor.submitDerivative(project.id, again);
  assert.notEqual(second.id, first.id, "each upload gets its own conversion");
  assert.equal(
    (await settled(supervisor, second.id)).state,
    "COMPLETED",
    supervisor.status(second.id).error ?? "",
  );
  assert.equal((await store.load(project.id)).assets.length, 2);
  await supervisor.close();
  store.close();
});

test("portrait phone video converts to its upright size", async () => {
  const { store, project, staged } = await vfrWorkspace({ rotate: 90 });
  assert.deepEqual(
    [staged.asset.width, staged.asset.height],
    [240, 320],
    "probe reports display dimensions",
  );
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submitDerivative(project.id, staged);
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  const [asset] = (await store.load(project.id)).assets;
  assert.deepEqual([asset.width, asset.height], [240, 320]);
  await supervisor.close();
  store.close();
});

test("odd-sized video converts at the nearest even size", async () => {
  const { store, project, staged } = await vfrWorkspace({
    size: "321x241",
    pixFmt: "yuv444p",
  });
  const supervisor = new JobSupervisor(store);
  await supervisor.start();
  const job = await supervisor.submitDerivative(project.id, staged);
  const done = await settled(supervisor, job.id);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  const [asset] = (await store.load(project.id)).assets;
  assert.deepEqual([asset.width, asset.height], [320, 240]);
  await supervisor.close();
  store.close();
});

test("the output rate is a standard rate, never the file's own tag", async () => {
  const { store, project, staged } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store);
  const rates: [{ num: number; den: number } | null, string][] = [
    [{ num: 1000, den: 1 }, "30/1"],
    [{ num: 1_000_000, den: 1 }, "30/1"],
    [{ num: 30000, den: 1001 }, "30000/1001"],
    [{ num: 59, den: 1 }, "60000/1001"],
    [{ num: 61, den: 1 }, "30/1"],
    [{ num: 24, den: 1 }, "24/1"],
    [null, "30/1"],
  ];
  for (const [frameRate, expected] of rates) {
    const job = await supervisor.submitDerivative(project.id, {
      asset: { ...staged.asset, id: crypto.randomUUID() },
      probe: { frameRate },
    });
    const payload = JSON.parse(
      (
        store.read((db) =>
          db.prepare("SELECT payload FROM jobs WHERE job_id = ?").get(job.id),
        ) as { payload: string }
      ).payload,
    );
    assert.equal(
      `${payload.frameRate.num}/${payload.frameRate.den}`,
      expected,
      JSON.stringify(frameRate),
    );
    supervisor.cancel(job.id);
  }
  await supervisor.close();
  store.close();
});

test("graceful shutdowns during a conversion never cost the upload", async () => {
  const { store, project, staged } = await vfrWorkspace();
  let job = "";
  // Three service runs each stop gracefully just after claiming the job.
  for (let run = 0; run < 3; run++) {
    const supervisor: JobSupervisor = new JobSupervisor(store, {
      fault: (point) => {
        if (point === "after-claim") void supervisor.close();
      },
    });
    await supervisor.start();
    if (!job) job = (await supervisor.submitDerivative(project.id, staged)).id;
    await supervisor.close();
    assert.equal(supervisor.status(job).state, "QUEUED", `run ${run}`);
  }
  assert.ok(store.assetVersion(staged.asset.id), "the upload is kept");
  const last = new JobSupervisor(store);
  await last.start();
  const done = await settled(last, job);
  assert.equal(done.state, "COMPLETED", done.error ?? "");
  assert.equal((await store.load(project.id)).assets.length, 1);
  await last.close();
  store.close();
});

test("active conversions per project are capped", async () => {
  const { store, project, staged } = await vfrWorkspace();
  // Four conversions already running (as a previous run left them).
  store.transaction((db) => {
    for (let i = 0; i < 4; i++)
      db.prepare(
        "INSERT INTO jobs(job_id, kind, project_id, frozen_revision, idempotency_key, payload, state) VALUES (?, 'cfr-derivative', ?, 0, ?, '{}', 'running')",
      ).run(crypto.randomUUID(), project.id, `busy-${i}`);
  });
  const supervisor = new JobSupervisor(store);
  await assert.rejects(
    supervisor.submitDerivative(project.id, staged),
    (e: unknown) => (e as { code?: string }).code === "LIMIT_EXCEEDED",
  );
  await supervisor.close();
  store.close();
});

test("the target rate follows the measured average, not a nominal peak", async () => {
  const { store, project, staged } = await vfrWorkspace();
  const supervisor = new JobSupervisor(store);
  const job = await supervisor.submitDerivative(project.id, {
    asset: { ...staged.asset, id: crypto.randomUUID() },
    probe: {
      frameRate: { num: 120, den: 1 },
      averageFrameRate: { num: 5994, den: 100 },
    },
  });
  const payload = JSON.parse(
    (
      store.read((db) =>
        db.prepare("SELECT payload FROM jobs WHERE job_id = ?").get(job.id),
      ) as { payload: string }
    ).payload,
  );
  assert.deepEqual(payload.frameRate, { num: 60000, den: 1001 });
  supervisor.cancel(job.id);
  await supervisor.close();
  store.close();
});
