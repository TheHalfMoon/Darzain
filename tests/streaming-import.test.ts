import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../core/store.ts";
import { mediaTools } from "../core/process/workers.ts";
import { CommandError, toCommandError } from "../core/command/errors.ts";

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      windowsHide: true,
    },
  );

async function workspace(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-stream-"));
  const store = new ProjectStore(root, options);
  await store.initialize();
  const project = await store.create("Streaming");
  return { root, store, project };
}
const staged = async (root: string, id: string) =>
  readdir(path.join(root, "projects", id, "imports"));
const rows = (root: string, table: string) => {
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
};

test("a streamed import records its object, version and probe (VFR identified)", async () => {
  const { root, store, project } = await workspace();
  const vfr = path.join(root, "vfr.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30:duration=2",
    "-vf",
    "select='not(mod(n\\,3))+eq(n\\,1)'",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "yuv420p",
    vfr,
  ]);
  const size = (await readFile(vfr)).length;
  const result = await store.importAsset(
    project.id,
    "vfr.mp4",
    createReadStream(vfr, { highWaterMark: 4096 }),
    size,
  );
  assert.equal(result.asset.bytes, size);
  assert.equal(result.probe.variableFrameRate, true);
  const version = store.assetVersion(result.asset.id)!;
  assert.deepEqual(
    [
      version.digest,
      version.bytes,
      version.state,
      version.probe.variableFrameRate,
    ],
    [result.asset.hash, size, "ready", true],
  );
  assert.deepEqual(await staged(root, project.id), [], "staging is removed");
  store.close();
});

test("uploads that lie about their size, end early or are not media leave nothing behind", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const bytes = await readFile(wav);
  const attempt = (
    source: AsyncIterable<Uint8Array> | Buffer,
    declared?: number,
    name = "tone.wav",
  ) =>
    store.importAsset(project.id, name, source, declared).then(
      () => null,
      (e: unknown) => toCommandError(e).code,
    );
  async function* chunks(...parts: Buffer[]) {
    for (const p of parts) yield p;
  }
  assert.equal(
    await attempt(chunks(bytes)),
    "LIMIT_EXCEEDED",
    "no declared size",
  );
  assert.equal(
    await attempt(chunks(bytes), 5 * 1024 ** 3),
    "LIMIT_EXCEEDED",
    "declared beyond policy",
  );
  assert.equal(
    await attempt(chunks(bytes), bytes.length - 10),
    "LIMIT_EXCEEDED",
    "more than declared",
  );
  assert.equal(
    await attempt(chunks(bytes.subarray(0, 100)), bytes.length),
    "VALIDATION",
    "ended early",
  );
  async function* broken() {
    yield bytes.subarray(0, 1000);
    throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  }
  assert.notEqual(
    await attempt(broken(), bytes.length),
    null,
    "client aborted",
  );
  assert.equal(
    await attempt(chunks(Buffer.alloc(1024 * 1024)), 1024 * 1024, "zeros.mp4"),
    "MEDIA_INVALID",
    "signature checked before the body is stored",
  );
  assert.deepEqual(await staged(root, project.id), []);
  assert.equal(rows(root, "asset_objects"), 0);
  assert.equal((await store.load(project.id)).revision, 0);
  store.close();
});

test("an injected out-of-space failure while staging commits nothing", async () => {
  let writes = 0;
  const { root, store, project } = await workspace({
    fault: (point: string) => {
      if (point === "stage-write" && ++writes === 2)
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
    },
  });
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav]);
  const size = (await readFile(wav)).length;
  await assert.rejects(
    store.importAsset(
      project.id,
      "tone.wav",
      createReadStream(wav, { highWaterMark: 4096 }),
      size,
    ),
    (e: unknown) => toCommandError(e).code === "LIMIT_EXCEEDED",
  );
  assert.deepEqual(await staged(root, project.id), []);
  assert.equal(rows(root, "asset_objects"), 0);
  assert.equal(rows(root, "asset_versions"), 0);
  assert.equal((await store.load(project.id)).assets.length, 0);
  store.close();
});

test("a version 1 workspace database upgrades step by step to the current version", async () => {
  const { root, store } = await workspace();
  store.close();
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "DROP TABLE attempts; DROP TABLE jobs; DROP TABLE supervisor; DROP TABLE asset_versions; DROP TABLE asset_objects; PRAGMA user_version = 1",
  );
  db.close();
  const reopened = new ProjectStore(root);
  await reopened.initialize();
  const check = new DatabaseSync(path.join(root, "workspace.sqlite"));
  assert.equal(
    (check.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    3,
  );
  assert.equal(rows(root, "asset_objects"), 0);
  assert.equal(rows(root, "jobs"), 0);
  assert.equal(rows(root, "supervisor"), 1);
  check.close();
  reopened.close();
});

test("CommandError codes stay stable for streaming failures", () => {
  assert.equal(new CommandError("LIMIT_EXCEEDED", "x").retryable, false);
});
