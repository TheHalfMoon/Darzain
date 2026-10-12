import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../core/store.ts";
import { fromEditView } from "../core/canonical.ts";
import { canonicalJson, sha256Hex } from "../core/donors/ninerr/canonical.ts";
import { CommandError } from "../core/command/errors.ts";

// Every test folder is removed when the file's tests finish, after the
// databases a failed test left open close (Windows cannot delete them open).
const bases: string[] = [];
const handles: { close(): void }[] = [];
after(() => {
  for (const handle of handles.reverse()) handle.close();
  return Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-canon-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  await store.initialize();
  const project = await store.create("Canonical");
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  handles.push({ close: () => db.isOpen && db.close() });
  // Simulates a snapshot written by another build, as a new head revision.
  const plant = (format: string, value: unknown, revision: number) => {
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const hash = sha256Hex(bytes);
    db.prepare(
      "INSERT INTO snapshots(hash, format, bytes, byte_length) VALUES (?, ?, ?, ?)",
    ).run(hash, format, bytes, bytes.length);
    db.prepare(
      "INSERT INTO revisions(project_id, revision, snapshot_hash, parent_revision, operation) VALUES (?, ?, ?, ?, 'test.plant')",
    ).run(project.id, revision, hash, revision - 1);
    db.prepare(
      "UPDATE projects SET revision = ?, snapshot_hash = ? WHERE project_id = ?",
    ).run(revision, hash, project.id);
    return { hash, bytes };
  };
  return { root, store, project, db, plant };
}

test("snapshots are stored in the canonical format", async () => {
  const { store, project, db } = await workspace();
  const row = db
    .prepare(
      "SELECT s.format, s.bytes FROM snapshots s JOIN projects p ON p.snapshot_hash = s.hash WHERE p.project_id = ?",
    )
    .get(project.id) as { format: string; bytes: Uint8Array };
  assert.equal(row.format, "yamakan.project/2");
  const stored = JSON.parse(Buffer.from(row.bytes).toString("utf8"));
  assert.deepEqual(
    [stored.format, stored.formatVersion, stored.language],
    ["yamakan.project", 2, "en"],
  );
  assert.deepEqual(stored, await store.exportProject(project.id));
  db.close();
  store.close();
});

test("a newer project format is inspectable but never edited or rewritten", async () => {
  const { store, project, db, plant } = await workspace();
  const future = {
    ...fromEditView({ ...project, revision: 1 }),
    formatVersion: 3,
    futureTimeline: { tracks: ["kept"] },
  };
  const planted = plant("yamakan.project/1", future, 1);
  await assert.rejects(
    store.load(project.id),
    (e: unknown) => e instanceof CommandError && e.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(
    store.save({ ...project, revision: 1 }, 1),
    /newer than this build/,
  );
  const history = await store.history(project.id);
  assert.deepEqual(
    history.snapshots.map((s) => [s.revision, s.verified]),
    [
      [1, false],
      [0, true],
    ],
  );
  const row = db
    .prepare("SELECT bytes FROM snapshots WHERE hash = ?")
    .get(planted.hash) as { bytes: Uint8Array };
  assert.deepEqual(
    Buffer.from(row.bytes),
    planted.bytes,
    "future bytes untouched",
  );
  db.close();
  store.close();
});

test("T2 edit-view snapshots upgrade on read and are never rewritten in place", async () => {
  const { store, project, db, plant } = await workspace();
  const view = { ...project, name: "Written by T2", revision: 1 };
  const planted = plant("yamakan.edit-view/1", view, 1);
  assert.deepEqual(await store.load(project.id), view);
  const saved = await store.save({ ...view, name: "Saved by T3" }, 1);
  assert.equal(saved.revision, 2);
  const formats = db
    .prepare(
      "SELECT r.revision, s.format FROM revisions r JOIN snapshots s ON s.hash = r.snapshot_hash WHERE r.project_id = ? ORDER BY r.revision",
    )
    .all(project.id)
    .map((r: any) => [r.revision, r.format]);
  assert.deepEqual(formats, [
    [0, "yamakan.project/2"],
    [1, "yamakan.edit-view/1"],
    [2, "yamakan.project/2"],
  ]);
  const row = db
    .prepare("SELECT bytes FROM snapshots WHERE hash = ?")
    .get(planted.hash) as { bytes: Uint8Array };
  assert.deepEqual(Buffer.from(row.bytes), planted.bytes);
  db.close();
  store.close();
});

test("restore never overwrites a head written in a newer format", async () => {
  const { store, project, db, plant } = await workspace();
  const future = {
    ...fromEditView({ ...project, revision: 1 }),
    formatVersion: 3,
  };
  const planted = plant("yamakan.project/1", future, 1);
  const history = await store.history(project.id);
  await assert.rejects(
    store.restore(project.id, 0, history.headFingerprint),
    (e: unknown) => e instanceof CommandError && e.code === "RECOVERY_REQUIRED",
  );
  const head = db
    .prepare(
      "SELECT revision, snapshot_hash FROM projects WHERE project_id = ?",
    )
    .get(project.id) as { revision: number; snapshot_hash: string };
  assert.deepEqual([head.revision, head.snapshot_hash], [1, planted.hash]);
  db.close();
  store.close();
});
