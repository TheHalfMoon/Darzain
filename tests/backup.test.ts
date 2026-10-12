import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../core/store.ts";
import {
  backupWorkspace,
  diagnoseWorkspace,
  healthy,
  offlineSource,
  restoreFromHome,
  restoreWorkspace,
} from "../core/recovery.ts";
import { inspectWal } from "../core/wal.ts";
import { CreativeAPI } from "../server/api.ts";
import { toCommandError } from "../core/command/errors.ts";

// Errors as the service reports them (schema errors become VALIDATION).
const code = (expected: string) => (e: unknown) =>
  toCommandError(e).code === expected;

const ffmpeg = process.env.DARZAIN_FFMPEG || "ffmpeg";
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Every test folder is removed when the file's tests finish.
const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);
async function workspace() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-backup-"));
  bases.push(base);
  const root = path.join(base, "workspace");
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Backed up");
  return { base, root, home: path.join(base, "recovery"), store, project };
}
// Distinct small PNGs (one per color), generated once per file.
async function png(dir: string, color: string) {
  const file = path.join(dir, `${color}.png`);
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${color}:s=32x32`,
      "-frames:v",
      "1",
      "-threads",
      "1",
      file,
    ],
    { windowsHide: true },
  );
  return readFile(file);
}
// Every file below a folder, with its bytes' hash.
async function tree(dir: string) {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(dir, file)] = sha256(await readFile(file));
    }
  return files;
}
const objectPath = (root: string, projectId: string, digest: string) =>
  path.join(
    root,
    "projects",
    projectId,
    "objects",
    "sha256",
    digest.slice(0, 2),
    digest,
  );

test("an online backup taken during imports, edits and garbage collection restores to a new root with the same snapshots", async () => {
  const { base, root, home, store, project } = await workspace();
  const colors = ["red", "green", "blue", "yellow", "white", "black"];
  const media = await Promise.all(colors.map((c) => png(base, c)));
  await store.importAsset(project.id, "red.png", media[0]);
  await store.importAsset(project.id, "green.png", media[1]);
  // A crash leftover: an unregistered object an hour and a half old.
  const orphan = Buffer.from("orphaned bytes");
  const orphanFile = objectPath(root, project.id, sha256(orphan));
  await mkdir(path.dirname(orphanFile), { recursive: true });
  await writeFile(orphanFile, orphan);
  const old = new Date(Date.now() - 90 * 60 * 1000);
  await utimes(orphanFile, old, old);

  let editing = true;
  let committed = 0;
  const edits = (async () => {
    for (let i = 0; editing || i < 5; i++) {
      const head = await store.load(project.id);
      await store.save({ ...head, name: `Edit ${i}` }, head.revision);
      committed++;
      // Edits arrive as separate requests: yield to the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const imports = (async () => {
    for (const [i, bytes] of media.slice(2).entries())
      await store.importAsset(project.id, `${colors[i + 2]}.png`, bytes);
  })();
  const collections = (async () => {
    const reports = [];
    while (editing) {
      reports.push(await store.collectGarbage());
      await new Promise((resolve) => setImmediate(resolve));
    }
    return reports;
  })();
  const before = committed;
  const backup = await backupWorkspace(store, home);
  // Work really overlapped the backup: edits committed while it ran.
  assert.ok(committed > before, "edits committed during the backup");
  editing = false;
  const [gc] = await Promise.all([collections, edits, imports]);
  assert.equal(backup.damaged, 0);
  // Garbage collection ran throughout (never removing anything while the
  // backup held objects; see the next test) and collects the orphan.
  assert.ok(gc.length > 0);
  const after = await store.collectGarbage();
  assert.ok(
    gc.some((r) => r.objects === 1) || after.objects === 1,
    "the orphan is collected",
  );
  await assert.rejects(stat(orphanFile));

  const restored = await restoreFromHome(home, backup.backupId);
  assert.ok(restored.root.startsWith(path.join(home, "restored")));
  assert.deepEqual(restored.quarantined, []);
  // Every restored revision is byte-identical (by snapshot hash) to the
  // source's revision of the same number, up to the restored head.
  const source = new DatabaseSync(path.join(root, "workspace.sqlite"), {
    readOnly: true,
  });
  const copy = new DatabaseSync(path.join(restored.root, "workspace.sqlite"), {
    readOnly: true,
  });
  const revisions = (db: DatabaseSync, upTo: number) =>
    db
      .prepare(
        "SELECT revision, snapshot_hash FROM revisions WHERE project_id = ? AND revision <= ? ORDER BY revision",
      )
      .all(project.id, upTo);
  const [head] = restored.projects;
  assert.equal(restored.projects.length, 1);
  assert.deepEqual(
    revisions(copy, head.revision),
    revisions(source, head.revision),
  );
  assert.equal(
    (
      source
        .prepare(
          "SELECT snapshot_hash FROM revisions WHERE project_id = ? AND revision = ?",
        )
        .get(project.id, head.revision) as { snapshot_hash: string }
    ).snapshot_hash,
    head.snapshotHash,
  );
  source.close();
  copy.close();
  // The restored workspace opens, and every asset of its head is served
  // from verified bytes.
  const reopened = new ProjectStore(restored.root);
  await reopened.initialize();
  const restoredHead = await reopened.load(project.id);
  assert.equal(restoredHead.revision, head.revision);
  assert.ok(restoredHead.assets.length >= 2);
  for (const asset of restoredHead.assets) {
    const { file } = await reopened.assetFile(project.id, asset.id);
    assert.equal(sha256(await readFile(file)), asset.hash);
  }
  reopened.close();
  // Neither the backup nor the restored root carries the client token,
  // exports or staging.
  for (const dir of [
    path.join(home, "backups", backup.backupId),
    restored.root,
  ])
    for (const file of Object.keys(await tree(dir)))
      assert.doesNotMatch(file, /^token$|exports|imports|service\.lock/, file);
  store.close();
});

test("an object released while a backup holds objects stays in place until the hold ends", async () => {
  const { base, root, store, project } = await workspace();
  const staged = await store.stageAsset(
    project.id,
    "staged.png",
    await png(base, "purple"),
  );
  const file = objectPath(root, project.id, staged.asset.hash);
  const release = store.holdObjects();
  await store.discardStagedVersion(project.id, staged.asset.id);
  assert.ok((await stat(file)).isFile(), "kept while held");
  const later = { graceMs: 0, now: Date.now() + 1000 };
  assert.equal((await store.collectGarbage(later)).objects, 0);
  release();
  assert.equal((await store.collectGarbage(later)).objects, 1);
  await assert.rejects(stat(file));
  store.close();
});

test("damaged media is recorded by the backup, quarantined on restore and never served", async () => {
  const { base, root, home, store, project } = await workspace();
  const good = await store.importAsset(
    project.id,
    "good.png",
    await png(base, "orange"),
  );
  const bad = await store.importAsset(
    project.id,
    "bad.png",
    await png(base, "cyan"),
  );
  // Same size, different bytes: only a hash check notices.
  const badFile = objectPath(root, project.id, bad.asset.hash);
  const damaged = Buffer.from(await readFile(badFile));
  damaged[damaged.length - 1] ^= 0xff;
  await writeFile(badFile, damaged);

  const backup = await backupWorkspace(store, home);
  assert.equal(backup.damaged, 1);
  // The damaged source is preserved as it was, for diagnosis.
  assert.deepEqual(await readFile(badFile), damaged);
  const manifest = JSON.parse(
    await readFile(
      path.join(home, "backups", backup.backupId, "backup.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.damaged, [
    { projectId: project.id, digest: bad.asset.hash, reason: "mismatch" },
  ]);
  const restored = await restoreFromHome(home, backup.backupId);
  assert.deepEqual(
    restored.quarantined.map((q) => q.digest),
    [bad.asset.hash],
  );
  const reopened = new ProjectStore(restored.root);
  await reopened.initialize();
  await assert.rejects(reopened.assetFile(project.id, bad.asset.id), {
    code: "RECOVERY_REQUIRED",
  });
  const served = await reopened.assetFile(project.id, good.asset.id);
  assert.equal(sha256(await readFile(served.file)), good.asset.hash);
  reopened.close();

  // A backup whose copy of an object was altered later: that object is
  // quarantined, the rest restores.
  const healthy = await backupWorkspace(store, home);
  const backupDir = path.join(home, "backups", healthy.backupId);
  const copied = objectPath(backupDir, project.id, good.asset.hash);
  const altered = Buffer.from(await readFile(copied));
  altered[0] ^= 0xff;
  await writeFile(copied, altered);
  const second = await restoreWorkspace(
    backupDir,
    path.join(base, "second-restore"),
  );
  assert.deepEqual(
    second.quarantined.map((q) => [q.digest, q.reason]).sort(),
    [
      [bad.asset.hash, "mismatch"],
      [good.asset.hash, "mismatch"],
    ].sort(),
  );

  // A database that does not match its manifest is refused, and the
  // destination is not left half-made.
  const db = path.join(backupDir, "workspace.sqlite");
  const bytes = Buffer.from(await readFile(db));
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(db, bytes);
  const third = path.join(base, "third-restore");
  await assert.rejects(restoreWorkspace(backupDir, third), {
    code: "RECOVERY_REQUIRED",
  });
  await assert.rejects(stat(third));
  // A destination that is not empty is refused and left untouched.
  const occupied = path.join(base, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep.txt"), "mine");
  await assert.rejects(
    restoreWorkspace(path.join(home, "backups", backup.backupId), occupied),
    { code: "VALIDATION" },
  );
  assert.deepEqual(await readdir(occupied), ["keep.txt"]);
  store.close();
});

test("diagnosis reports a corrupt database and missing media without changing the workspace", async () => {
  const { base, root, store, project } = await workspace();
  const asset = await store.importAsset(
    project.id,
    "a.png",
    await png(base, "pink"),
  );
  const orphan = objectPath(root, project.id, "ab".repeat(32));
  await mkdir(path.dirname(orphan), { recursive: true });
  await writeFile(orphan, "stray");
  store.close();

  // Healthy database, one object missing, one unregistered file.
  const missing = objectPath(root, project.id, asset.asset.hash);
  const kept = await readFile(missing);
  await writeFile(`${missing}.moved`, kept);
  await rm(missing);
  const untouched = await tree(root);
  const report = await diagnoseWorkspace(root, { verifyObjects: true });
  assert.deepEqual(await tree(root), untouched);
  assert.equal(healthy(report), false);
  assert.deepEqual(report.database.integrity, ["ok"]);
  assert.equal(report.projects.length, 1);
  assert.deepEqual(
    report.objects.missing.map((o) => o.digest),
    [asset.asset.hash],
  );
  assert.equal(report.unregisteredFiles, 1);

  // A damaged database: diagnosis reports it, the service refuses it, and
  // every file of the workspace is left byte-identical.
  const file = path.join(root, "workspace.sqlite");
  const bytes = Buffer.from(await readFile(file));
  bytes.fill(0x5a, 4096, Math.min(bytes.length, 4096 * 3));
  await writeFile(file, bytes);
  const before = await tree(root);
  const damaged = await diagnoseWorkspace(root);
  assert.ok(
    damaged.database.error !== null || damaged.database.integrity?.[0] !== "ok",
    JSON.stringify(damaged.database),
  );
  await assert.rejects(new ProjectStore(root).initialize(), {
    code: "RECOVERY_REQUIRED",
  });
  assert.deepEqual(await tree(root), before);
  // The command-line form exits non-zero for an unhealthy workspace.
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.resolve("cli/recovery.ts"), "diagnose", root],
        { stdio: "pipe", windowsHide: true },
      ),
    (e: { status: number }) => e.status === 2,
  );
  assert.deepEqual(await tree(root), before);
});

test("backup commands choose their folders; incomplete backups are listed but cannot be restored", async () => {
  const { base, root, home, store } = await workspace();
  const api = new CreativeAPI(store, { recoveryHome: home });
  const made = (await api.call("yamakan.workspace.backup", {})) as {
    backupId: string;
  };
  const incomplete = "20260101T000000Z-0000abcd";
  await mkdir(path.join(home, "backups", incomplete), { recursive: true });
  const listed = (await api.call("yamakan.workspace.backups", {})) as {
    backupId: string;
    complete: boolean;
  }[];
  assert.deepEqual(
    listed.map((b) => [b.backupId, b.complete]),
    [
      [made.backupId, true],
      [incomplete, false],
    ],
  );
  await assert.rejects(
    api.call("yamakan.workspace.restore", { backupId: incomplete }),
    code("VALIDATION"),
  );
  // Only backup ids are accepted, never paths.
  for (const backupId of ["../workspace", path.join(base, "x")])
    await assert.rejects(
      api.call("yamakan.workspace.restore", { backupId }),
      code("VALIDATION"),
    );
  const restored = (await api.call("yamakan.workspace.restore", {
    backupId: made.backupId,
  })) as { root: string };
  assert.equal(path.dirname(restored.root), path.join(home, "restored"));
  // A recovery folder inside the workspace is refused.
  const inside = new CreativeAPI(store, {
    recoveryHome: path.join(root, "recovery"),
  });
  await assert.rejects(
    inside.call("yamakan.workspace.backup", {}),
    code("VALIDATION"),
  );
  store.close();
});

test("a damaged write-ahead log is diagnosed and refused, and stays as found; a torn last frame is not damage", async () => {
  const { base, root, store, project } = await workspace();
  for (let i = 0; i < 12; i++) {
    const head = await store.load(project.id);
    await store.save({ ...head, name: `Revision ${i}` }, head.revision);
  }
  const head = (await store.load(project.id)).revision;
  // A crash image: the database and its log as they are while open.
  const crashed = path.join(base, "crashed");
  await mkdir(crashed);
  for (const name of ["workspace.sqlite", "workspace.sqlite-wal"])
    await copyFile(path.join(root, name), path.join(crashed, name));
  store.close();
  const wal = path.join(crashed, "workspace.sqlite-wal");
  const healthyLog = await inspectWal(wal);
  assert.equal(healthyLog?.damaged, false);
  assert.ok((healthyLog?.validCommits ?? 0) >= 12);

  // A torn final write is what a crash leaves; it opens normally.
  const torn = path.join(base, "torn");
  await mkdir(torn);
  await copyFile(
    path.join(crashed, "workspace.sqlite"),
    path.join(torn, "workspace.sqlite"),
  );
  const tornLog = Buffer.from(await readFile(wal));
  tornLog.fill(0x11, tornLog.length - 64);
  await writeFile(path.join(torn, "workspace.sqlite-wal"), tornLog);
  assert.equal(
    (await inspectWal(path.join(torn, "workspace.sqlite-wal")))?.damaged,
    false,
  );

  // A power cut can tear any frame of the last, unsynced transaction (here
  // its first frame never reached the disk); SQLite drops only that
  // transaction, so the workspace opens.
  const cut = path.join(base, "power-cut");
  await mkdir(cut);
  await copyFile(
    path.join(crashed, "workspace.sqlite"),
    path.join(cut, "workspace.sqlite"),
  );
  const cutLog = Buffer.from(await readFile(wal));
  const frameBytes = 24 + cutLog.readUInt32BE(8);
  const frames = (cutLog.length - 32) / frameBytes;
  const isCommit = (i: number) =>
    cutLog.readUInt32BE(32 + i * frameBytes + 4) !== 0;
  let previous = frames - 2;
  while (previous >= 0 && !isCommit(previous)) previous--;
  assert.ok(isCommit(frames - 1));
  assert.ok(frames - 1 - previous >= 2, "the last transaction spans frames");
  cutLog.fill(
    0,
    32 + (previous + 1) * frameBytes,
    32 + (previous + 2) * frameBytes,
  );
  await writeFile(path.join(cut, "workspace.sqlite-wal"), cutLog);
  const cutReport = await inspectWal(path.join(cut, "workspace.sqlite-wal"));
  assert.equal(cutReport?.damaged, false);
  assert.equal(cutReport?.unsyncedTail, true);
  const reopened = new ProjectStore(cut);
  await reopened.initialize();
  assert.equal((await reopened.load(project.id)).revision, head - 1);
  reopened.close();

  // Damage in the middle: SQLite would silently drop later commits.
  const log = Buffer.from(await readFile(wal));
  log.fill(0x5a, Math.floor(log.length / 2), Math.floor(log.length / 2) + 2000);
  await writeFile(wal, log);
  const before = await tree(crashed);
  const report = await diagnoseWorkspace(crashed);
  assert.equal(report.database.wal?.damaged, true);
  assert.ok((report.database.wal?.lostCommits ?? 0) > 0);
  assert.ok(
    report.projects[0].revision < head,
    "the database alone shows an older head",
  );
  assert.equal(healthy(report), false);
  await assert.rejects(new ProjectStore(crashed).initialize(), {
    code: "RECOVERY_REQUIRED",
  });
  await assert.rejects(offlineSource(crashed), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await tree(crashed), before, "the log is left as found");
});

test("malformed object rows are recorded, quarantined on restore and reported by diagnosis", async () => {
  const { base, root, home, store, project } = await workspace();
  await store.importAsset(project.id, "ok.png", await png(base, "navy"));
  store.close();
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.prepare(
    "INSERT INTO asset_objects(project_id, digest, byte_length, state, generation) VALUES (?, ?, 10, 'ready', 1)",
  ).run("../evil", "AB".repeat(32));
  // An id longer than a report keeps is still quarantined as stored.
  db.prepare(
    "INSERT INTO asset_objects(project_id, digest, byte_length, state, generation) VALUES (?, ?, 10, 'ready', 1)",
  ).run("x".repeat(300), "cd".repeat(32));
  db.close();
  const report = await diagnoseWorkspace(root);
  assert.deepEqual(
    report.objects.invalid.map((o) => o.projectId.slice(0, 7)),
    ["../evil", "xxxxxxx"],
  );
  // The offline backup reads the database as it is and records the row.
  const source = await offlineSource(root);
  let made;
  try {
    made = await backupWorkspace(source, home);
  } finally {
    await source.close();
  }
  assert.equal(made.damaged, 2);
  const restored = await restoreFromHome(home, made.backupId);
  assert.deepEqual(
    restored.quarantined.map((q) => [q.projectId.slice(0, 7), q.reason]),
    [
      ["../evil", "invalid"],
      ["xxxxxxx", "invalid"],
    ],
  );
  const check = new DatabaseSync(path.join(restored.root, "workspace.sqlite"), {
    readOnly: true,
  });
  const stillReady = (
    check
      .prepare(
        "SELECT count(*) AS n FROM asset_objects WHERE state = 'ready' AND (project_id = '../evil' OR length(project_id) = 300)",
      )
      .get() as { n: number }
  ).n;
  check.close();
  assert.equal(stillReady, 0);
  assert.equal(restored.objectsVerified, 1);
  // Nothing was written outside the restored root.
  await assert.rejects(stat(path.join(home, "restored", "evil")));
});

test("restores are refused without disk space, run one at a time and never nest in the workspace", async () => {
  const { base, root, home, store } = await workspace();
  const made = await backupWorkspace(store, home);
  const backupDir = path.join(home, "backups", made.backupId);
  // Space other work has promised counts against the restore.
  const target = path.join(base, "no-space");
  await assert.rejects(
    restoreWorkspace(backupDir, target, {
      reservedBytes: Number.MAX_SAFE_INTEGER,
    }),
    { code: "LIMIT_EXCEEDED" },
  );
  await assert.rejects(stat(target));
  // Concurrent restores: one runs, the other is told to retry.
  const results = await Promise.allSettled([
    restoreFromHome(home, made.backupId),
    restoreFromHome(home, made.backupId),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  const refused = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(refused.reason.code, "BUSY");
  assert.deepEqual(await readdir(path.join(home, "restored")), [
    `${made.backupId}-1`,
  ]);
  // A folder whose name begins with two dots is still inside the workspace.
  await assert.rejects(backupWorkspace(store, path.join(root, "..rec")), {
    code: "VALIDATION",
  });
  await assert.rejects(stat(path.join(root, "..rec")));
  // A restore into a folder inside its own backup is refused and leaves
  // nothing behind.
  await assert.rejects(restoreWorkspace(backupDir, path.join(backupDir, "x")), {
    code: "VALIDATION",
  });
  await assert.rejects(stat(path.join(backupDir, "x")));
  store.close();
});
