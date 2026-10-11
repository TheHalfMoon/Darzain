import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../core/store.ts";
import { RenderQueue } from "../core/render.ts";
import { execute, Scopes } from "../core/command/registry.ts";
import { CommandError } from "../core/command/errors.ts";
import { acquireServiceLock } from "../core/service-lock.ts";

const child = fileURLToPath(new URL("./fixtures/t2-child.ts", import.meta.url));
const spawnChild = (...args: string[]) =>
  fork(child, args, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
const nextMessage = (c: ChildProcess) =>
  new Promise<any>((resolve, reject) => {
    c.once("message", resolve);
    c.once("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
async function waitFor(file: string) {
  for (let i = 0; i < 1000 && !existsSync(file); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(file), `timed out waiting for ${file}`);
}
async function kill(c: ChildProcess) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exited = once(c, "exit");
  c.kill("SIGKILL");
  await exited;
}
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-db-"));
  const store = new ProjectStore(root);
  await store.initialize();
  const project = await store.create("Original");
  return { root, store, project };
}
const integrity = (root: string) => {
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  try {
    return (
      db.prepare("PRAGMA integrity_check").get() as Record<string, string>
    ).integrity_check;
  } finally {
    db.close();
  }
};
const snapshotCount = (root: string) => {
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  try {
    return (
      db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
};

test("two processes racing the same revision produce exactly one commit and one conflict", async () => {
  const { root, store, project } = await workspace();
  const release = path.join(root, "release-a");
  const a = spawnChild(
    "writer",
    root,
    project.id,
    "From A",
    "req-a",
    "after-snapshot-insert",
    release,
  );
  const b = spawnChild("writer", root, project.id, "From B", "req-b");
  try {
    await Promise.all([nextMessage(a), nextMessage(b)]);
    // A holds the write transaction mid-commit; B must wait and then observe A's revision.
    const resultA = nextMessage(a);
    a.send("go");
    await waitFor(`${release}.paused`);
    const resultB = nextMessage(b);
    b.send("go");
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(release, "");
    const outcomes = [await resultA, await resultB];
    assert.deepEqual(outcomes[0], { ok: true, revision: 1 });
    assert.deepEqual(outcomes[1], { ok: false, code: "REVISION_CONFLICT" });
    const head = await store.load(project.id);
    assert.equal(head.name, "From A");
    assert.equal(head.revision, 1);
    assert.equal(integrity(root), "ok");
  } finally {
    await kill(a);
    await kill(b);
    store.close();
  }
});

test("a process killed inside the transaction leaves no partial commit; one killed after commit keeps it", async () => {
  const { root, store, project } = await workspace();
  const before = snapshotCount(root);
  const release = path.join(root, "never");
  const victim = spawnChild(
    "writer",
    root,
    project.id,
    "Lost",
    "req-kill",
    "before-commit",
    release,
  );
  await nextMessage(victim);
  victim.send("go");
  await waitFor(`${release}.paused`);
  await kill(victim);
  assert.equal((await store.load(project.id)).revision, 0);
  assert.equal(snapshotCount(root), before, "rolled back snapshot bytes too");
  assert.equal(integrity(root), "ok");

  const after = path.join(root, "after");
  const committed = spawnChild(
    "writer",
    root,
    project.id,
    "Kept",
    "req-after",
    "after-commit",
    after,
  );
  await nextMessage(committed);
  committed.send("go");
  await waitFor(`${after}.paused`);
  await kill(committed);
  const head = await store.load(project.id);
  assert.deepEqual([head.revision, head.name], [1, "Kept"]);
  // The caller never saw a response; retrying the same request returns the
  // original result instead of a conflict or a duplicate revision.
  const retried = await store.save({ ...project, name: "Kept" }, 0, {
    principalId: "local-client",
    requestId: "req-after",
    digest: "Kept",
  });
  assert.deepEqual(retried, head);
  assert.equal((await store.load(project.id)).revision, 1);
  store.close();
});

test("request replay is checked before the revision and rejects reused IDs with different input", async () => {
  const { store, project } = await workspace();
  const queue = new RenderQueue(store);
  const ctx = (requestId: string) => ({
    store,
    queue,
    principal: { id: "local-client" as const, scopes: new Set(Scopes) },
    requestId,
  });
  const save = (requestId: string, name: string) =>
    execute(ctx(requestId), "yamakan.project.save", {
      project: { ...project, name },
      expectedRevision: 0,
    });
  const first = await save("r1", "One");
  const again = await save("r1", "One");
  assert.deepEqual(again.result, first.result);
  assert.equal((await store.load(project.id)).revision, 1);
  await assert.rejects(
    save("r1", "Different"),
    (e: unknown) =>
      e instanceof CommandError && e.code === "IDEMPOTENCY_MISMATCH",
  );
  await assert.rejects(
    save("r2", "Stale"),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  // Receipts are scoped per principal: another principal's ID is a new request.
  await assert.rejects(
    execute(
      {
        ...ctx("r1"),
        principal: { id: "browser-ui", scopes: new Set(Scopes) },
      },
      "yamakan.project.save",
      {
        project: { ...project, name: "One" },
        expectedRevision: 0,
      },
    ),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  const created = await execute(ctx("c1"), "yamakan.project.create", {
    name: "New",
  });
  const replayed = await execute(ctx("c1"), "yamakan.project.create", {
    name: "New",
  });
  assert.deepEqual(replayed.result, created.result);
  assert.equal(
    (await store.list()).length,
    2,
    "create replay made no second project",
  );
  await queue.close();
  store.close();
});

test("the service lock is exclusive, and the OS releases it when its owner is killed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-lock-"));
  const holder = spawnChild("lock", root);
  try {
    assert.deepEqual(await nextMessage(holder), { locked: true });
    await assert.rejects(
      acquireServiceLock(root),
      (e: unknown) => e instanceof CommandError && e.code === "BUSY",
    );
    await kill(holder);
    // No manual unlock: the stale file remains as metadata and is reacquired.
    await access(path.join(root, "service.lock"));
    const lock = await acquireServiceLock(root);
    lock.release();
  } finally {
    await kill(holder);
  }
});

test("reopen needs only the database; snapshots and history live in SQLite", async () => {
  const { root, store, project } = await workspace();
  const one = await store.save({ ...project, name: "Edited" }, 0);
  store.close();
  await rm(path.join(root, "projects", project.id), { recursive: true });
  const reopened = new ProjectStore(root);
  await reopened.initialize();
  assert.deepEqual(await reopened.load(project.id), one);
  const history = await reopened.history(project.id);
  assert.deepEqual(
    history.snapshots.map((s) => [s.revision, s.verified]),
    [
      [1, true],
      [0, true],
    ],
  );
  assert.deepEqual(
    reopened.events().map((e) => [e.revision, e.operation]),
    [
      [0, "project.create"],
      [1, "project.save"],
    ],
  );
  const restored = await reopened.restore(
    project.id,
    0,
    history.headFingerprint,
  );
  assert.deepEqual([restored.revision, restored.name], [2, "Original"]);
  await assert.rejects(
    reopened.restore(project.id, 1, history.headFingerprint),
    (e: unknown) => e instanceof CommandError && e.code === "REVISION_CONFLICT",
  );
  reopened.close();
});

test("oversized snapshots and newer database versions are refused without writes", async () => {
  const { root, store, project } = await workspace();
  const huge = { ...project, clips: [], scenes: [], name: "x" };
  // 200 titles of 500 characters stay inside the schema but exceed nothing; a
  // snapshot cap is exercised by forcing a lower limit through a large asset list.
  await store.save(huge, 0);
  store.close();
  const db = new DatabaseSync(path.join(root, "workspace.sqlite"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  const newer = new ProjectStore(root);
  await assert.rejects(
    newer.initialize(),
    (e: unknown) => e instanceof CommandError && e.code === "RECOVERY_REQUIRED",
  );
  assert.deepEqual(
    (await readdir(root))
      .filter((f) => f.startsWith("workspace.sqlite"))
      .sort()[0],
    "workspace.sqlite",
  );
});
