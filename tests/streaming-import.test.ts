import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../core/store.ts";
import { mediaTools } from "../core/process/workers.ts";
import { probe } from "../core/media.ts";
import { CommandError, toCommandError } from "../core/command/errors.ts";

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      windowsHide: true,
    },
  );

// Every test folder is removed when the file's tests finish, after the
// stores opened in it close (Windows cannot delete them open).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});
async function workspace(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-stream-"));
  bases.push(root);
  const store = new ProjectStore(root, options);
  handles.push(store);
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
  // The stage-and-attach shortcut refuses VFR video and keeps nothing.
  await assert.rejects(
    store.importAsset(project.id, "vfr.mp4", await readFile(vfr)),
    (e: unknown) =>
      e instanceof CommandError && e.code === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(rows(root, "asset_objects"), 0);
  assert.equal(rows(root, "asset_versions"), 0);
  const result = await store.stageAsset(
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

test("a version 2 workspace with imported media upgrades to the current version and keeps it", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const { asset } = await store.importAsset(
    project.id,
    "tone.wav",
    await readFile(wav),
  );
  store.close();
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "DROP TABLE edit_cursor; DROP TABLE edit_history; DROP TABLE attempts; DROP TABLE jobs; DROP TABLE supervisor; PRAGMA user_version = 2",
  );
  db.close();
  const reopened = new ProjectStore(root);
  handles.push(reopened);
  await reopened.initialize();
  const check = new DatabaseSync(path.join(root, "workspace.sqlite"));
  assert.equal(
    (check.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    5,
  );
  assert.equal(rows(root, "jobs"), 0);
  assert.equal(rows(root, "supervisor"), 1);
  check.close();
  assert.equal(reopened.assetVersion(asset.id)!.state, "ready");
  await reopened.assetFile(project.id, asset.id);
  reopened.close();
});

test("a version 1 workspace database upgrades step by step to the current version", async () => {
  const { root, store } = await workspace();
  store.close();
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "DROP TABLE edit_cursor; DROP TABLE edit_history; DROP TABLE attempts; DROP TABLE jobs; DROP TABLE supervisor; DROP TABLE asset_versions; DROP TABLE asset_objects; DROP TABLE pending_work; PRAGMA user_version = 1",
  );
  db.close();
  const reopened = new ProjectStore(root);
  handles.push(reopened);
  await reopened.initialize();
  const check = new DatabaseSync(path.join(root, "workspace.sqlite"));
  assert.equal(
    (check.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    5,
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

test("the same bytes imported twice share one object with two versions", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const bytes = await readFile(wav);
  const first = await store.importAsset(project.id, "a.wav", bytes);
  // A reader holding the stored object open does not block a second import.
  const held = await open(
    (await store.assetFile(project.id, first.asset.id)).file,
    "r",
  );
  try {
    const second = await store.importAsset(project.id, "b.wav", bytes);
    assert.equal(second.asset.hash, first.asset.hash);
    assert.notEqual(second.asset.id, first.asset.id);
  } finally {
    await held.close();
  }
  assert.equal(rows(root, "asset_objects"), 1);
  assert.equal(rows(root, "asset_versions"), 2);
  store.close();
});

test("a damaged stored object is refused rather than served", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const { asset } = await store.importAsset(
    project.id,
    "a.wav",
    await readFile(wav),
  );
  const { file } = await store.assetFile(project.id, asset.id);
  await truncate(file, 100);
  await assert.rejects(
    store.assetFile(project.id, asset.id),
    (e: unknown) => e instanceof CommandError && e.code === "RECOVERY_REQUIRED",
  );
  store.close();
});

test("playlist and concat files cannot reach other files or the network", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-playlist-"));
  bases.push(root);
  const target = path.join(root, "secret.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", target]);
  const playlists = {
    "list.m3u8": `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${target}\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n`,
    "list.ffconcat": `ffconcat version 1.0\nfile '${target.replaceAll("\\", "/")}'\n`,
  };
  for (const [name, text] of Object.entries(playlists)) {
    const file = path.join(root, name);
    await writeFile(file, text);
    // Control: without the format whitelist, ffprobe treats the file as a
    // playlist (hls or concat) and reaches for the files it names.
    const control = spawnSync(
      mediaTools().ffprobe,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=format_name",
        "-of",
        "csv=p=0",
        file,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.match(
      `${control.stdout}${control.stderr}`,
      /hls|concat|secret\.wav/,
      `${name} would be followed without the whitelist`,
    );
    await assert.rejects(
      probe(file),
      (e: unknown) => e instanceof CommandError && e.code === "MEDIA_INVALID",
      name,
    );
  }
});

test("upgrading to schema v2 registers existing assets (ready, or quarantined if damaged)", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const good = await store.importAsset(
    project.id,
    "good.wav",
    await readFile(wav),
  );
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=1", wav]);
  const bad = await store.importAsset(
    project.id,
    "bad.wav",
    await readFile(wav),
  );
  const badFile = (await store.assetFile(project.id, bad.asset.id)).file;
  store.close();
  await truncate(badFile, 10);
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "DROP TABLE edit_cursor; DROP TABLE edit_history; DROP TABLE attempts; DROP TABLE jobs; DROP TABLE supervisor; DROP TABLE asset_versions; DROP TABLE asset_objects; DROP TABLE pending_work; PRAGMA user_version = 1",
  );
  db.close();
  const reopened = new ProjectStore(root);
  handles.push(reopened);
  await reopened.initialize();
  assert.equal(reopened.assetVersion(good.asset.id)!.state, "ready");
  assert.equal(reopened.assetVersion(bad.asset.id)!.state, "quarantined");
  await reopened.assetFile(project.id, good.asset.id);
  await assert.rejects(
    reopened.assetFile(project.id, bad.asset.id),
    /not ready/,
  );
  reopened.close();
});

test("an injected out-of-space failure while publishing commits nothing", async () => {
  const { root, store, project } = await workspace({
    fault: (point: string) => {
      if (point === "stage-publish")
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
    },
  });
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  await assert.rejects(
    store.importAsset(project.id, "tone.wav", await readFile(wav)),
    (e: unknown) => toCommandError(e).code === "LIMIT_EXCEEDED",
  );
  assert.deepEqual(await staged(root, project.id), []);
  assert.equal(rows(root, "asset_objects"), 0);
  store.close();
});

test("slow uploads time out and concurrent uploads are capped, releasing their reservations", async () => {
  const { root, store, project } = await workspace({ uploadGraceMs: 300 });
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const bytes = await readFile(wav);
  // Two uploads that send their header and then stall.
  const stalled = [new PassThrough(), new PassThrough()];
  const pending = stalled.map((s, i) => {
    s.write(bytes.subarray(0, 64));
    return store
      .importAsset(project.id, `slow-${i}.wav`, s, 8 * 1024 * 1024)
      .then(
        () => "imported",
        (e: unknown) => toCommandError(e).code,
      );
  });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    store.importAsset(project.id, "third.wav", bytes),
    (e: unknown) => e instanceof CommandError && e.code === "BUSY",
  );
  // 8 MiB at the 1 MiB/s minimum plus a 300 ms grace: both stall out.
  assert.deepEqual(
    await Promise.all(
      pending.map((p) =>
        Promise.race([
          p,
          new Promise((r) => setTimeout(() => r("still-open"), 30_000)),
        ]),
      ),
    ),
    ["LIMIT_EXCEEDED", "LIMIT_EXCEEDED"],
  );
  // Reservations and slots were released: a normal import works again.
  assert.equal(
    (await store.importAsset(project.id, "after.wav", bytes)).asset.bytes,
    bytes.length,
  );
  assert.deepEqual(await staged(root, project.id), []);
  store.close();
});

test("an interrupted v2 backfill resumes on the next start", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const { asset } = await store.importAsset(
    project.id,
    "a.wav",
    await readFile(wav),
  );
  store.close();
  // As if the process died after the schema step committed, before the backfill.
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec(
    "DELETE FROM asset_versions; DELETE FROM asset_objects; INSERT INTO pending_work(name) VALUES ('asset-backfill')",
  );
  db.close();
  const reopened = new ProjectStore(root);
  handles.push(reopened);
  await reopened.initialize();
  assert.equal(reopened.assetVersion(asset.id)!.state, "ready");
  assert.equal(rows(root, "pending_work"), 0);
  reopened.close();
});

test("imports started in the same tick still respect the concurrency cap", async () => {
  const { root, store, project } = await workspace({ uploadGraceMs: 200 });
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const header = (await readFile(wav)).subarray(0, 64);
  const outcomes = await Promise.all(
    [0, 1, 2].map((i) => {
      const s = new PassThrough();
      s.write(header);
      return store
        .importAsset(project.id, `race-${i}.wav`, s, 1024 * 1024)
        .then(
          () => "imported",
          (e: unknown) => toCommandError(e).code,
        );
    }),
  );
  assert.deepEqual(outcomes.sort(), [
    "BUSY",
    "LIMIT_EXCEEDED",
    "LIMIT_EXCEEDED",
  ]);
  store.close();
});

test("objects resolve only with a canonical media extension", async () => {
  const { root, store, project } = await workspace();
  const wav = path.join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const { asset } = await store.importAsset(
    project.id,
    "tone.wav",
    await readFile(wav),
  );
  assert.ok(await store.readyObjectFile(project.id, asset));
  await assert.rejects(
    store.readyObjectFile(project.id, {
      ...asset,
      extension: "x/../../other/assets/name.mp4",
    }),
    (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
  );
  store.close();
});
