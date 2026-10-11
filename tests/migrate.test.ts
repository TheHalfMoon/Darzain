import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegacyProjectStore } from "../core/legacy-store.ts";
import { ProjectStore } from "../core/store.ts";
import {
  isLegacyWorkspace,
  migrateLegacyWorkspace,
  sourceDigest,
} from "../core/migrate.ts";
import { CommandError } from "../core/command/errors.ts";

const ffmpeg =
  process.env.YAMAKAN_FFMPEG || process.env.DARZAIN_FFMPEG || "ffmpeg";

async function legacyWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-legacy-"));
  const legacy = new LegacyProjectStore(path.join(root, "src"));
  await legacy.initialize();
  const wav = path.join(root, "tone.wav");
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      wav,
    ],
    { windowsHide: true },
  );
  // Project A: create → import → two edits (revisions 0..3).
  const a = await legacy.create("Legacy film");
  const imported = await legacy.importAsset(
    a.id,
    "tone.wav",
    await readFile(wav),
  );
  let p = imported.project;
  p.clips.push({
    id: crypto.randomUUID(),
    trackId: p.tracks[1].id,
    assetId: imported.asset.id,
    startFrame: 3,
    durationFrames: 40,
    sourceFrame: 5,
    title: null,
  });
  p = await legacy.save(p, p.revision);
  p.clips.push({
    id: crypto.randomUUID(),
    trackId: p.tracks[0].id,
    assetId: null,
    startFrame: 0,
    durationFrames: 30,
    sourceFrame: 0,
    title: "عنوان · Title",
  });
  p = await legacy.save(p, p.revision);
  // Project B: two revisions, then a corrupted head file.
  const b = await legacy.create("Damaged head");
  await legacy.save({ ...b, name: "Damaged head v1" }, 0);
  await writeFile(
    path.join(root, "src", "projects", b.id, "head.json"),
    "interrupted",
  );
  return { root, source: path.join(root, "src"), a: p, b };
}

test("legacy workspace migrates into a new root with history, media and an unchanged source", async () => {
  const { root, source, a, b } = await legacyWorkspace();
  assert.equal(await isLegacyWorkspace(source), true);
  const before = await sourceDigest(source);
  const destination = path.join(root, "dest");
  const report = await migrateLegacyWorkspace(source, destination);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(await sourceDigest(source), before, "source bytes unchanged");
  assert.equal(
    await isLegacyWorkspace(source),
    true,
    "no database written to the source",
  );

  const migratedA = report.projects.find((x) => x.projectId === a.id)!;
  assert.deepEqual(
    [
      migratedA.status,
      migratedA.headRevision,
      migratedA.migratedRevisions,
      migratedA.objects,
    ],
    ["migrated", 3, [0, 1, 2, 3], 1],
  );
  const skippedB = report.projects.find((x) => x.projectId === b.id)!;
  assert.equal(skippedB.status, "skipped");
  assert.match(skippedB.reason!, /head cannot be verified/);

  const store = new ProjectStore(destination);
  await store.initialize();
  assert.deepEqual(
    await store.load(a.id),
    a,
    "edit and timing semantics preserved",
  );
  const exported = await store.exportProject(a.id);
  assert.equal(exported.format, "yamakan.project");
  const audioClip = exported.clips.find((c) => c.assetId !== null)!;
  assert.deepEqual(
    [audioClip.startTicks, audioClip.durationTicks, audioClip.sourceStartTicks],
    [3 * 23_520_000, 40 * 23_520_000, 5 * 23_520_000],
  );
  const history = await store.history(a.id);
  assert.deepEqual(
    history.snapshots.map((s) => [s.revision, s.verified]),
    [
      [3, true],
      [2, true],
      [1, true],
      [0, true],
    ],
  );
  const media = await store.assetFile(a.id, a.assets[0].id);
  assert.equal(media.asset.hash, a.assets[0].hash);
  // The migrated project keeps working: a new edit commits revision 4.
  const edited = await store.save({ ...a, name: "Edited after migration" }, 3);
  assert.equal(edited.revision, 4);
  store.close();

  const reportText = await readFile(
    path.join(destination, "migration", "report.json"),
    "utf8",
  );
  assert.ok(!reportText.includes(root), "report has no absolute paths");
  assert.ok(
    !JSON.stringify(exported).includes(root),
    "export has no host paths",
  );
});

test("a damaged legacy head migrates only with explicit acceptance, and says so", async () => {
  const { root, source, b } = await legacyWorkspace();
  const report = await migrateLegacyWorkspace(source, path.join(root, "dest"), {
    acceptLatestVerified: true,
  });
  const outcome = report.projects.find((x) => x.projectId === b.id)!;
  assert.deepEqual(
    [
      outcome.status,
      outcome.headRevision,
      outcome.headReplacedByLatestVerified,
    ],
    ["migrated", 1, true],
  );
});

test("migration refuses unsafe or ambiguous source and destination roots", async () => {
  const { root, source } = await legacyWorkspace();
  const nonEmpty = path.join(root, "occupied");
  await mkdir(nonEmpty);
  await writeFile(path.join(nonEmpty, "keep.txt"), "user data");
  const refused = async (src: string, dst: string, pattern: RegExp) =>
    assert.rejects(
      migrateLegacyWorkspace(src, dst),
      (e: unknown) => e instanceof CommandError && pattern.test(e.message),
    );
  await refused(source, nonEmpty, /new or empty/);
  await refused(source, path.join(source, "inside"), /separate folders/);
  await refused(root, path.join(source, "..", "x"), /separate folders/);
  await refused(
    path.join(root, "occupied"),
    path.join(root, "d2"),
    /not a legacy/,
  );
  assert.deepEqual(await readdir(nonEmpty), ["keep.txt"]);
  // A new-format workspace is not a legacy one.
  const modern = await mkdtemp(path.join(tmpdir(), "yamakan-modern-"));
  const store = new ProjectStore(modern);
  await store.initialize();
  await store.create("Modern");
  store.close();
  assert.equal(await isLegacyWorkspace(modern), false);
});
