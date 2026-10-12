import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  unlink,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
// The pre-database file store remains the read-only source for legacy migration (T3).
import { LegacyProjectStore as ProjectStore } from "../core/legacy-store.ts";
import { ProjectSchema } from "../core/project.ts";

// Every test folder is removed when the file's tests finish.
const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "darzain-recovery-"));
  bases.push(root);
  const store = new ProjectStore(root);
  await store.initialize();
  return { root, store, project: await store.create("Original") };
}
test("oversized corrupt head is fingerprinted with bounded memory and preserved during explicit restore", async () => {
  const { store, project } = await fixture();
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x78);
  await writeFile(await store.file(project.id, "head.json"), bytes);
  const history = await store.history(project.id);
  assert.equal(history.currentRevision, null);
  assert.equal(history.snapshots[0].verified, true);
  const restored = await store.restore(project.id, 0, history.headFingerprint);
  assert.equal(restored.revision, 1);
  const dir = await store.file(project.id, "recovery");
  const files = await readdir(dir);
  assert.deepEqual(
    await readFile(
      path.join(
        dir,
        files.find((x) => x.endsWith(".head.bin"))!,
      ),
    ),
    bytes,
  );
});
test("a verified current head remains restorable when its separate receipt is damaged", async () => {
  const { store, project } = await fixture();
  const receipt = await store.file(project.id, "snapshots", "0.receipt.json");
  await writeFile(receipt, "damaged receipt");
  const history = await store.history(project.id);
  assert.equal(history.snapshots[0].verified, true);
  assert.equal(
    (await store.restore(project.id, 0, history.headFingerprint)).revision,
    1,
  );
  assert.equal(await readFile(receipt, "utf8"), "damaged receipt");
  assert.equal(
    (await store.history(project.id)).snapshots.find((x) => x.revision === 0)
      ?.verified,
    false,
  );
});
test("explicit recovery preserves corrupt head and damaged snapshot, then reopens a new revision", async () => {
  const { root, store, project } = await fixture();
  const one = await store.save({ ...project, name: "Recovered edit" }, 0);
  await store.save({ ...one, name: "Damaged edit" }, 1);
  const damaged = await store.file(project.id, "snapshots", "2.json");
  await writeFile(damaged, "damaged snapshot");
  const head = await store.file(project.id, "head.json"),
    bytes = await readFile(head);
  const history = await store.history(project.id);
  assert.equal(history.currentRevision, null);
  assert.deepEqual(
    history.snapshots.map((x) => [x.revision, x.verified]),
    [
      [2, false],
      [1, true],
      [0, true],
    ],
  );
  const restored = ProjectSchema.parse(
    await store.restore(project.id, 1, history.headFingerprint),
  );
  assert.equal(restored.name, "Recovered edit");
  assert.equal(restored.revision, 3);
  assert.deepEqual(await new ProjectStore(root).load(project.id), restored);
  assert.equal(await readFile(damaged, "utf8"), "damaged snapshot");
  const recovery = await store.file(project.id, "recovery"),
    files = await readdir(recovery);
  assert.deepEqual(
    await readFile(
      path.join(
        recovery,
        files.find((x) => x.endsWith(".head.bin"))!,
      ),
    ),
    bytes,
  );
  await assert.rejects(
    store.restore(project.id, 0, history.headFingerprint),
    /conflict/,
  );
});
test("missing or malformed head can be recovered only from a verified receipt", async () => {
  const { store, project } = await fixture();
  await writeFile(await store.file(project.id, "head.json"), "broken head");
  let history = await store.history(project.id);
  assert.equal(history.currentRevision, null);
  assert.equal(
    (await store.restore(project.id, 0, history.headFingerprint)).revision,
    1,
  );
  await unlink(await store.file(project.id, "head.json"));
  history = await store.history(project.id);
  assert.equal(history.headFingerprint, null);
  assert.equal((await store.restore(project.id, 0, null)).revision, 2);
  await writeFile(
    await store.file(project.id, "snapshots", "0.receipt.json"),
    "{}",
  );
  await assert.rejects(
    store.restore(
      project.id,
      0,
      (await store.history(project.id)).headFingerprint,
    ),
  );
  assert.equal((await store.load(project.id)).revision, 2);
});
test("interrupted head publication leaves current revision intact and never clobbers the orphan snapshot", async () => {
  const { store, project } = await fixture();
  const atomic = store.atomic.bind(store);
  store.atomic = async (file, body) => {
    if (file.endsWith("head.json"))
      throw new Error("Injected publication interruption");
    return atomic(file, body);
  };
  await assert.rejects(
    store.save({ ...project, name: "Interrupted" }, 0),
    /interruption/,
  );
  assert.equal((await store.load(project.id)).revision, 0);
  const orphan = await readFile(
    await store.file(project.id, "snapshots", "1.json"),
  );
  store.atomic = atomic;
  const saved = await store.save({ ...project, name: "Retry" }, 0);
  assert.equal(saved.revision, 2);
  assert.deepEqual(
    await readFile(await store.file(project.id, "snapshots", "1.json")),
    orphan,
  );
  assert.deepEqual(
    (await store.history(project.id)).snapshots.map((x) => x.verified),
    [true, true, true],
  );
});
test("legacy current head gains an integrity receipt before save; unanchored older snapshots remain unverified", async () => {
  const { store, project } = await fixture();
  const saved = await store.save({ ...project, name: "Legacy" }, 0);
  for (const revision of [0, 1])
    await unlink(
      await store.file(project.id, "snapshots", `${revision}.receipt.json`),
    );
  assert.deepEqual(
    (await store.history(project.id)).snapshots.map((x) => x.verified),
    [true, false],
  );
  await store.save({ ...saved, name: "Migrated" }, 1);
  assert.deepEqual(
    (await store.history(project.id)).snapshots.map((x) => x.verified),
    [true, true, false],
  );
});
test("content storage deduplicates real media, rejects tampering on recovery, and preserves legacy asset compatibility", async () => {
  const { root, store, project } = await fixture();
  const source = path.join(root, "fixture.png");
  execFileSync(
    process.env.DARZAIN_FFMPEG || "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=64x64",
      "-frames:v",
      "1",
      "-threads",
      "1",
      source,
    ],
    { windowsHide: true },
  );
  const bytes = await readFile(source);
  const first = await store.importAsset(project.id, "first.png", bytes);
  const second = await store.importAsset(project.id, "second.png", bytes);
  const object = await store.assetFile(project.id, first.asset.id);
  assert.equal(
    object.file,
    (await store.assetFile(project.id, second.asset.id)).file,
  );
  const shard = path.dirname(object.file);
  assert.equal((await readdir(shard)).length, 1);
  await writeFile(object.file, "corrupt");
  const before = await readFile(await store.file(project.id, "head.json"));
  await assert.rejects(
    store.restore(
      project.id,
      first.project.revision,
      (await store.history(project.id)).headFingerprint,
    ),
    /match expected SHA|integrity/,
  );
  assert.deepEqual(
    await readFile(await store.file(project.id, "head.json")),
    before,
  );
  await writeFile(object.file, bytes);
  const legacy = await store.file(
    project.id,
    "assets",
    `${first.asset.hash}.png`,
  );
  await rename(object.file, legacy);
  assert.equal(
    (await store.assetFile(project.id, first.asset.id)).file,
    legacy,
  );
  assert.equal(
    (
      await store.restore(
        project.id,
        first.project.revision,
        (await store.history(project.id)).headFingerprint,
      )
    ).assets.length,
    1,
  );
});
