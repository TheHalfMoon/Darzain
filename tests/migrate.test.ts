import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  symlink,
} from "node:fs/promises";
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
  await refused(root, path.join(source, "..", "x"), /not a legacy/);
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

test("the service refuses to open a legacy root, and the CLI migrates it", async () => {
  const { root, source, a } = await legacyWorkspace();
  const before = await sourceDigest(source);
  const server = fork(
    fileURLToPath(new URL("../server/main.ts", import.meta.url)),
    [],
    {
      env: { ...process.env, YAMAKAN_WORKSPACE: source, YAMAKAN_PORT: "24395" },
      silent: true,
      windowsHide: true,
    },
  );
  let stderr = "";
  server.stderr?.on("data", (c) => (stderr += String(c)));
  const [code] = await once(server, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /pre-Yamakan format and was not opened/);
  assert.equal(
    await sourceDigest(source),
    before,
    "the refused root is untouched",
  );

  const destination = path.join(root, "via-cli");
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../cli/migrate.ts", import.meta.url)),
      source,
      destination,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    cli.status,
    2,
    "one project was skipped, so the exit code says so",
  );
  assert.match(cli.stdout, new RegExp(`migrated ${a.id} revisions 0,1,2,3`));
  assert.match(cli.stdout, /Source unchanged: true/);
  assert.equal(await sourceDigest(source), before);
});

test("one unreadable project is skipped and reported; the others still publish", async () => {
  const { root, source, a } = await legacyWorkspace();
  // A stray project folder with a head but no snapshots.
  const stray = crypto.randomUUID();
  await mkdir(path.join(source, "projects", stray));
  await writeFile(path.join(source, "projects", stray, "head.json"), "{}");
  const destination = path.join(root, "dest");
  const report = await migrateLegacyWorkspace(source, destination);
  const outcome = report.projects.find((p) => p.projectId === stray)!;
  assert.equal(outcome.status, "skipped");
  assert.ok(
    outcome.reason && !outcome.reason.includes(root),
    "reason has no host path",
  );
  assert.equal(
    report.projects.find((p) => p.projectId === a.id)!.status,
    "migrated",
  );
  assert.ok(
    !(await readdir(root)).some((f) => f.includes(".migrating-")),
    "staging was published, not left behind",
  );
  const written = JSON.parse(
    await readFile(path.join(destination, "migration", "report.json"), "utf8"),
  );
  assert.deepEqual(written, report);
});

test("verified revisions after the legacy head are reported, not migrated", async () => {
  const { root, source, a } = await legacyWorkspace();
  // Simulate an interrupted head publication: the head still names revision 2
  // while revision 3 and its receipt were fully written.
  const dir = path.join(source, "projects", a.id);
  await writeFile(
    path.join(dir, "head.json"),
    await readFile(path.join(dir, "snapshots", "2.receipt.json")),
  );
  const report = await migrateLegacyWorkspace(source, path.join(root, "dest"));
  const outcome = report.projects.find((p) => p.projectId === a.id)!;
  assert.deepEqual(
    [
      outcome.headRevision,
      outcome.migratedRevisions,
      outcome.revisionsAfterHead,
    ],
    [2, [0, 1, 2], [3]],
  );
});

test("a legacy root that an earlier build opened in place still migrates", async () => {
  const { root, source, a } = await legacyWorkspace();
  // The T2 server created workspace.sqlite inside the legacy root.
  // The earlier build also created a project that exists only in its database.
  const opened = new ProjectStore(source);
  await opened.initialize();
  const dbOnly = await opened.create("Created by the earlier build");
  const imported = await opened.importAsset(
    dbOnly.id,
    "tone.wav",
    await readFile(path.join(root, "tone.wav")),
  );
  const edited = await opened.save(
    { ...imported.project, name: "Edited by the earlier build" },
    imported.project.revision,
  );
  opened.close();
  assert.equal(await isLegacyWorkspace(source), true);
  const before = await sourceDigest(source);
  const destination = path.join(root, "dest");
  const report = await migrateLegacyWorkspace(source, destination);
  assert.equal(await sourceDigest(source), before);
  assert.equal(
    report.projects.find((p) => p.projectId === a.id)!.status,
    "migrated",
  );
  const outcome = report.projects.find((p) => p.projectId === dbOnly.id)!;
  assert.deepEqual(
    [outcome.status, outcome.migratedRevisions, outcome.objects],
    ["migrated", [0, 1, 2], 1],
  );
  const store = new ProjectStore(destination);
  await store.initialize();
  assert.deepEqual(await store.load(dbOnly.id), edited);
  await store.assetFile(dbOnly.id, imported.asset.id);
  store.close();
  assert.ok(
    !(await readdir(path.join(destination, "migration"))).includes(
      "source-database",
    ),
    "the private database copy is removed",
  );
});

test("destinations that alias into the source by junction or short name are refused", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows path aliasing");
  const { root, source, a } = await legacyWorkspace();
  const before = await sourceDigest(source);
  const exportsDir = path.join(source, "projects", a.id, "exports");
  const junction = path.join(root, "alias");
  await symlink(source, junction, "junction");
  const refused = (dst: string) =>
    assert.rejects(
      migrateLegacyWorkspace(source, dst),
      (e: unknown) =>
        e instanceof CommandError && /separate folders|Network/.test(e.message),
      dst,
    );
  await refused(path.join(junction, "projects", a.id, "exports"));
  await refused(path.join(junction, "projects", a.id, "exports", "new"));
  await refused("\\\\localhost\\" + exportsDir.replace(":", "$"));
  // 8.3 short names exist only where the volume generates them.
  const short = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TARGET).ShortPath",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, TARGET: exportsDir },
    },
  ).stdout.trim();
  if (short && short.toLowerCase() !== exportsDir.toLowerCase())
    await refused(short);
  else t.diagnostic("no 8.3 short name on this volume");
  assert.equal(
    await sourceDigest(source),
    before,
    "nothing was written into the source",
  );
});

test("database projects with a newer-format revision are never downgraded", async () => {
  const { root, source } = await legacyWorkspace();
  const opened = new ProjectStore(source);
  await opened.initialize();
  const project = await opened.create("Touched by a newer build");
  opened.close();
  const db = new DatabaseSync(path.join(source, "workspace.sqlite"));
  const row = db
    .prepare(
      "SELECT s.bytes FROM snapshots s JOIN projects p ON p.snapshot_hash = s.hash WHERE p.project_id = ?",
    )
    .get(project.id) as { bytes: Uint8Array };
  const newer = {
    ...JSON.parse(Buffer.from(row.bytes).toString("utf8")),
    revision: 1,
    formatVersion: 2,
  };
  const bytes = Buffer.from(JSON.stringify(newer));
  const hash = createHash("sha256").update(bytes).digest("hex");
  db.prepare(
    "INSERT INTO snapshots(hash, format, bytes, byte_length) VALUES (?, 'yamakan.project/1', ?, ?)",
  ).run(hash, bytes, bytes.length);
  db.prepare(
    "INSERT INTO revisions(project_id, revision, snapshot_hash, parent_revision, operation) VALUES (?, 1, ?, 0, 'newer.build')",
  ).run(project.id, hash);
  db.prepare(
    "UPDATE projects SET revision = 1, snapshot_hash = ? WHERE project_id = ?",
  ).run(hash, project.id);
  db.close();
  const report = await migrateLegacyWorkspace(source, path.join(root, "dest"), {
    acceptLatestVerified: true,
  });
  const outcome = report.projects.find((p) => p.projectId === project.id)!;
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason!, /newer format/);
});
