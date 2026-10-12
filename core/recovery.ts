// Recovery (plan T9): online workspace backups, restore into a new root and
// read-only diagnosis. A backup is a database copy taken online plus every
// ready content object it registers, each re-hashed as it is copied, and a
// manifest written last; a folder without a manifest is not a backup.
// Restore never writes into an existing workspace: it builds a new root,
// verifies every byte against the manifest and the content addresses, and
// quarantines what it cannot verify instead of failing the whole restore.
//
// The manifest and the database copy sit in the same folder, so the
// manifest's hashes detect corruption, truncation and partial copies, not
// deliberate tampering; the restore receipt names the manifest's hash for
// an out-of-band check.
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { Id } from "./project.ts";
import { initializeRoot, safePath } from "./paths.ts";
import { CommandError } from "./command/errors.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";
import { inspectWal } from "./wal.ts";

export const BACKUP_FORMAT = "yamakan.backup/1";
export const RESTORE_FORMAT = "yamakan.restore/1";
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const BackupId = z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
// Restores kept per backup; older restored folders are the user's to remove.
const MAX_RESTORES_PER_BACKUP = 20;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

// What a backup leaves out, stated in every manifest: derived files that
// are rebuilt from the database (exports, previews), in-flight staging, and
// secrets and locks that belong to one running service.
const EXCLUDED = [
  "token",
  "service.lock",
  "projects/*/exports",
  "projects/*/imports",
  "projects/*/cache",
];

// Damaged entries name database rows as found, which may be malformed; they
// are data only and never become paths.
const Reported = z.string().max(200);
const ManifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupId: BackupId,
    createdAt: z.iso.datetime(),
    schemaVersion: z.number().int().positive(),
    database: z
      .object({ sha256: Digest, bytes: z.number().int().positive() })
      .strict(),
    projects: z.array(
      z
        .object({
          projectId: Id,
          revision: z.number().int().nonnegative(),
          snapshotHash: Digest,
        })
        .strict(),
    ),
    objects: z.array(
      z
        .object({
          projectId: Id,
          digest: Digest,
          bytes: z.number().int().positive(),
        })
        .strict(),
    ),
    damaged: z.array(
      z
        .object({
          projectId: Reported,
          digest: Reported,
          reason: z.enum(["missing", "mismatch", "invalid"]),
        })
        .strict(),
    ),
    excluded: z.array(z.string().max(80)),
  })
  .strict();
export type BackupManifest = z.infer<typeof ManifestSchema>;
type Damage = BackupManifest["damaged"][number];

type Head = { projectId: string; revision: number; snapshotHash: string };
type ObjectRow = { projectId: string; digest: string; bytes: number };

// What a backup reads from: the running store, or an offline workspace.
export type BackupSource = {
  readonly root: string;
  // Bytes other work has promised on the same volume (in-flight imports).
  readonly reservedBytes: number;
  backupDatabase(destination: string): Promise<void>;
  holdObjects(): () => void;
};

// The canonical place of an object below a root; every part is validated,
// so a manifest or database row cannot name another path.
const objectParts = (projectId: string, digest: string) => [
  "projects",
  Id.parse(projectId),
  "objects",
  "sha256",
  Digest.parse(digest).slice(0, 2),
  digest,
];

const isInside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
// Neither folder may contain the other: a backup inside the workspace
// would copy itself, and a workspace inside the backups would be backed up
// with them.
export async function assertSeparate(root: string, other: string) {
  const real = (p: string) => realpath(p).catch(() => path.resolve(p));
  // Windows paths compare without case; POSIX paths with it.
  const fold = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const a = fold(await real(root));
  const b = fold(await real(other));
  if (isInside(a, b) || isInside(b, a))
    throw new CommandError(
      "VALIDATION",
      "Backups and restores must be outside the workspace folder.",
    );
}

const sha256File = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const sizeOf = async (file: string) =>
  (await lstat(file).catch(() => null))?.size ?? 0;
const freeBytes = async (dir: string) => {
  const space = await statfs(dir);
  return Number(space.bavail) * Number(space.bsize);
};
// The nearest folder that exists (a restore target may not yet).
async function existingAncestor(p: string) {
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    if ((await lstat(dir).catch(() => null))?.isDirectory()) return dir;
    if (path.dirname(dir) === dir) return dir;
  }
}
// Space for `bytes` more, keeping the policy's reserve and what other work
// on the volume has already promised.
async function requireSpace(dir: string, bytes: number, reserved = 0) {
  if (
    (await freeBytes(dir)) <
    bytes + reserved + RESOURCE_POLICY.enforced.diskReserveBytes
  )
    throw new CommandError(
      "LIMIT_EXCEEDED",
      "Not enough free disk space for this recovery operation.",
    );
}

// Copies a file to `target` through a private partial file, hashing as it
// goes; the target appears (by rename) only if the bytes match.
async function copyVerified(
  source: string,
  target: string,
  expected: { sha256: string; bytes: number },
): Promise<"ok" | "missing" | "mismatch"> {
  const info = await lstat(source).catch(() => null);
  if (!info?.isFile()) return "missing";
  if (info.size !== expected.bytes) return "mismatch";
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.partial-${randomBytes(4).toString("hex")}`;
  const hash = createHash("sha256");
  let written = 0;
  const out = await open(partial, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(source)) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      written += bytes.length;
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await out.write(bytes, offset);
        offset += bytesWritten;
      }
    }
    await out.sync();
  } catch (e) {
    await out.close().catch(() => {});
    await rm(partial, { force: true });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
  await out.close();
  if (written !== expected.bytes || hash.digest("hex") !== expected.sha256) {
    await rm(partial, { force: true });
    return "mismatch";
  }
  await rename(partial, target);
  return "ok";
}

function integrity(db: DatabaseSync) {
  const rows = db.prepare("PRAGMA integrity_check(20)").all() as {
    integrity_check: string;
  }[];
  return rows.length === 1 && rows[0].integrity_check === "ok"
    ? null
    : rows.map((r) => r.integrity_check);
}
const userVersion = (db: DatabaseSync) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
function heads(db: DatabaseSync): Head[] {
  return (
    db
      .prepare(
        "SELECT project_id, revision, snapshot_hash FROM projects ORDER BY project_id",
      )
      .all() as {
      project_id: string;
      revision: number;
      snapshot_hash: string;
    }[]
  ).map((r) => ({
    projectId: r.project_id,
    revision: r.revision,
    snapshotHash: r.snapshot_hash,
  }));
}
function readyObjects(db: DatabaseSync): ObjectRow[] {
  return (
    db
      .prepare(
        "SELECT project_id, digest, byte_length FROM asset_objects WHERE state = 'ready' ORDER BY project_id, digest",
      )
      .all() as { project_id: string; digest: string; byte_length: number }[]
  ).map((r) => ({
    projectId: r.project_id,
    digest: r.digest,
    bytes: r.byte_length,
  }));
}
// A row whose project id or digest cannot name an object path.
const malformed = (o: { projectId: string; digest: string }) =>
  !Id.safeParse(o.projectId).success || !Digest.safeParse(o.digest).success;

// The file holding an object in a live workspace: the content-addressed
// path, or the pre-v2 `assets/<hash>.<extension>` layout.
async function sourceObject(root: string, projectId: string, digest: string) {
  const canonical = await safePath(root, ...objectParts(projectId, digest));
  if ((await lstat(canonical).catch(() => null))?.isFile()) return canonical;
  const assets = await safePath(root, "projects", projectId, "assets");
  for (const name of await readdir(assets).catch(() => [] as string[]))
    if (/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name) && name.startsWith(digest))
      return safePath(assets, name);
  return canonical;
}

export function defaultRecoveryHome(root: string) {
  return path.join(path.dirname(root), `${path.basename(root)}-recovery`);
}

// One recovery operation (backup or restore) at a time per process: each
// may write as much as the workspace holds.
let running = false;
async function exclusive<T>(work: () => Promise<T>) {
  if (running)
    throw new CommandError(
      "BUSY",
      "A backup or restore is already running; retry when it finishes.",
    );
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}

// Backs up a workspace into `<home>/backups/<id>`. With a running store,
// edits, imports and jobs continue meanwhile; the backup is the state at
// the moment its database copy completed.
export function backupWorkspace(
  source: BackupSource,
  home: string,
  options: { now?: Date } = {},
) {
  return exclusive(async () => {
    const release = source.holdObjects();
    let dir: string | null = null;
    try {
      const now = options.now ?? new Date();
      const backupId = `${now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")}-${randomBytes(4).toString("hex")}`;
      await assertSeparate(source.root, home);
      await mkdir(home, { recursive: true });
      const backups = await safePath(home, "backups");
      await mkdir(backups, { recursive: true });
      const target = await safePath(home, "backups", backupId);
      // The database copy is at most the database plus its log.
      const live = path.join(source.root, "workspace.sqlite");
      await requireSpace(
        backups,
        (await sizeOf(live)) + (await sizeOf(`${live}-wal`)),
        source.reservedBytes,
      );
      await mkdir(target);
      dir = target;
      const database = path.join(dir, "workspace.sqlite");
      await source.backupDatabase(database);
      const copy = new DatabaseSync(database);
      let schemaVersion: number, projects: Head[], objects: ObjectRow[];
      try {
        // The copy is a standalone file: no write-ahead log beside it.
        copy.exec("PRAGMA journal_mode = DELETE");
        const problems = integrity(copy);
        if (problems)
          throw new CommandError(
            "RECOVERY_REQUIRED",
            `The database copy failed its integrity check: ${problems[0]}`,
          );
        schemaVersion = userVersion(copy);
        projects = heads(copy);
        objects = readyObjects(copy);
      } finally {
        copy.close();
      }
      await requireSpace(
        dir,
        objects.reduce((n, o) => n + o.bytes, 0),
        source.reservedBytes,
      );
      const copied: ObjectRow[] = [];
      const damaged: Damage[] = [];
      for (const object of objects) {
        if (malformed(object)) {
          damaged.push({ ...reported(object), reason: "invalid" });
          continue;
        }
        const result = await copyVerified(
          await sourceObject(source.root, object.projectId, object.digest),
          await safePath(dir, ...objectParts(object.projectId, object.digest)),
          { sha256: object.digest, bytes: object.bytes },
        );
        if (result === "ok") copied.push(object);
        else damaged.push({ ...reported(object), reason: result });
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        backupId,
        createdAt: now.toISOString(),
        schemaVersion,
        database: {
          sha256: await sha256File(database),
          bytes: (await lstat(database)).size,
        },
        projects,
        objects: copied,
        damaged,
        excluded: EXCLUDED,
      };
      // Written last and atomically: its presence marks a complete backup.
      const partial = path.join(dir, "backup.json.partial");
      const handle = await open(partial, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(manifest, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partial, path.join(dir, "backup.json"));
      return summary(manifest);
    } catch (e) {
      // Only the folder this backup created is removed.
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      release();
    }
  });
}

const reported = (o: { projectId: string; digest: string }) => ({
  projectId: String(o.projectId).slice(0, 200),
  digest: String(o.digest).slice(0, 200),
});

const summary = (m: BackupManifest) => ({
  backupId: m.backupId,
  createdAt: m.createdAt,
  complete: true as const,
  projects: m.projects.length,
  objects: m.objects.length,
  bytes: m.database.bytes + m.objects.reduce((n, o) => n + o.bytes, 0),
  damaged: m.damaged.length,
});

async function readManifest(dir: string) {
  const file = path.join(dir, "backup.json");
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
    throw new Error("backup.json is not a regular file of bounded size.");
  return ManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

// Backups in a recovery home, newest first. A folder without a valid
// manifest is listed as incomplete and cannot be restored.
export async function listBackups(home: string) {
  const result: (
    ReturnType<typeof summary> | { backupId: string; complete: false }
  )[] = [];
  const backups = await safePath(home, "backups").catch(() => null);
  if (!backups) return result;
  for (const name of await readdir(backups).catch(() => [] as string[])) {
    if (!BackupId.safeParse(name).success) continue;
    try {
      const manifest = await readManifest(await safePath(backups, name));
      if (manifest.backupId !== name) throw new Error("Mismatched backup id.");
      result.push(summary(manifest));
    } catch {
      result.push({ backupId: name, complete: false });
    }
  }
  return result.sort((a, b) => b.backupId.localeCompare(a.backupId));
}

// Restores a backup into a new, empty root and returns the restore receipt
// (also written as `restore.json` in the new root).
export function restoreWorkspace(
  backupDir: string,
  newRoot: string,
  options: { reservedBytes?: number } = {},
) {
  return exclusive(() => restore(backupDir, newRoot, options));
}

async function restore(
  backupDir: string,
  newRoot: string,
  options: { reservedBytes?: number },
) {
  let manifest: BackupManifest;
  try {
    manifest = await readManifest(backupDir);
  } catch {
    throw new CommandError(
      "VALIDATION",
      "This folder is not a complete Yamakan backup (backup.json is missing or invalid).",
    );
  }
  const root = path.resolve(newRoot);
  let existed = true;
  try {
    if ((await readdir(root)).length > 0)
      throw new CommandError(
        "VALIDATION",
        "Restore destination must be a new, empty folder.",
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    existed = false;
  }
  // Checked before anything is created.
  await assertSeparate(root, backupDir);
  const total =
    manifest.database.bytes + manifest.objects.reduce((n, o) => n + o.bytes, 0);
  await requireSpace(
    await existingAncestor(root),
    total,
    options.reservedBytes,
  );
  let initialized = false;
  try {
    await initializeRoot(root);
    initialized = true;
    const database = path.join(root, "workspace.sqlite");
    if (
      (await copyVerified(path.join(backupDir, "workspace.sqlite"), database, {
        sha256: manifest.database.sha256,
        bytes: manifest.database.bytes,
      })) !== "ok"
    )
      throw new CommandError(
        "RECOVERY_REQUIRED",
        "The backup's database does not match its manifest.",
      );
    let restored: Head[];
    let ready: ObjectRow[];
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      const problems = integrity(check);
      if (problems)
        throw new CommandError(
          "RECOVERY_REQUIRED",
          `The restored database failed its integrity check: ${problems[0]}`,
        );
      if (userVersion(check) !== manifest.schemaVersion)
        throw new CommandError(
          "RECOVERY_REQUIRED",
          "The restored database's version does not match the backup manifest.",
        );
      restored = heads(check);
      if (JSON.stringify(restored) !== JSON.stringify(manifest.projects))
        throw new CommandError(
          "RECOVERY_REQUIRED",
          "The restored project heads do not match the backup manifest.",
        );
      ready = readyObjects(check);
    } finally {
      check.close();
    }
    // Every object the database registers as ready must be verified here;
    // anything else (recorded as damaged, absent from the manifest, altered
    // in the backup, or malformed) is quarantined.
    const listed = new Map(
      manifest.objects.map((o) => [`${o.projectId}/${o.digest}`, o]),
    );
    const recorded = new Map(
      manifest.damaged.map((d) => [`${d.projectId}/${d.digest}`, d.reason]),
    );
    const quarantined: { projectId: string; digest: string; reason: string }[] =
      [];
    let verified = 0;
    for (const row of ready) {
      const key = `${row.projectId}/${row.digest}`;
      const entry = listed.get(key);
      let result: string = recorded.get(key) ?? "unlisted";
      if (entry && !malformed(row) && entry.bytes === row.bytes) {
        const parts = objectParts(row.projectId, row.digest);
        result = await copyVerified(
          await safePath(backupDir, ...parts),
          await safePath(root, ...parts),
          { sha256: row.digest, bytes: row.bytes },
        );
      }
      if (result === "ok") verified++;
      else quarantined.push({ ...reported(row), reason: result });
    }
    // What could not be verified is kept registered but never served.
    const db = new DatabaseSync(database);
    try {
      const quarantine = db.prepare(
        "UPDATE asset_objects SET state = 'quarantined' WHERE project_id = ? AND digest = ?",
      );
      db.exec("BEGIN IMMEDIATE");
      for (const q of quarantined) quarantine.run(q.projectId, q.digest);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const receipt = {
      format: RESTORE_FORMAT,
      backupId: manifest.backupId,
      backupCreatedAt: manifest.createdAt,
      manifestSha256: createHash("sha256")
        .update(await readFile(path.join(backupDir, "backup.json")))
        .digest("hex"),
      restoredAt: new Date().toISOString(),
      database: manifest.database,
      projects: restored,
      objectsVerified: verified,
      quarantined,
    };
    const partial = path.join(root, "restore.json.partial");
    await writeFile(partial, JSON.stringify(receipt, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(partial, path.join(root, "restore.json"));
    return { root, ...receipt };
  } catch (e) {
    // Only what this restore made is removed: the folder if it created it,
    // otherwise (the folder was empty) its contents.
    if (!existed)
      await rm(root, { recursive: true, force: true }).catch(() => {});
    else if (initialized)
      for (const name of await readdir(root).catch(() => [] as string[]))
        await rm(path.join(root, name), { recursive: true, force: true }).catch(
          () => {},
        );
    throw e;
  }
}

// Restores a backup of a recovery home into a fresh folder of that home.
export async function restoreFromHome(
  home: string,
  backupId: string,
  options: { reservedBytes?: number } = {},
) {
  const id = BackupId.parse(backupId);
  const dir = await safePath(home, "backups", id);
  if (!(await lstat(dir).catch(() => null))?.isDirectory())
    throw new CommandError("NOT_FOUND", "Backup not found.");
  const restored = await safePath(home, "restored");
  await mkdir(restored, { recursive: true });
  for (let n = 1; n <= MAX_RESTORES_PER_BACKUP; n++) {
    const target = await safePath(home, "restored", `${id}-${n}`);
    if (await lstat(target).catch(() => null)) continue;
    // A failed restore removes the folder it created.
    return restoreWorkspace(dir, target, options);
  }
  throw new CommandError(
    "LIMIT_EXCEEDED",
    `This backup has been restored ${MAX_RESTORES_PER_BACKUP} times; remove older restored folders first.`,
  );
}

// An offline workspace as a backup source (no service may be running: the
// caller holds the service lock). The database is read through a read-only
// connection and never upgraded; a damaged write-ahead log is refused.
export async function offlineSource(root: string) {
  const file = await safePath(root, "workspace.sqlite");
  if (!(await lstat(file).catch(() => null))?.isFile())
    throw new CommandError(
      "NOT_FOUND",
      "No workspace database in this folder.",
    );
  if ((await inspectWal(`${file}-wal`))?.damaged)
    throw new CommandError(
      "RECOVERY_REQUIRED",
      "The workspace's write-ahead log is damaged; diagnose it before backing up.",
    );
  const sides = [`${file}-wal`, `${file}-shm`];
  const present = await Promise.all(
    sides.map((p) =>
      lstat(p).then(
        () => true,
        () => false,
      ),
    ),
  );
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    root,
    reservedBytes: 0,
    backupDatabase: (destination: string) =>
      backup(db, destination, { rate: -1 }).then(() => {}),
    holdObjects: () => () => {},
    // Closes the connection and removes only side files it created.
    async close() {
      db.close();
      for (const [i, side] of sides.entries())
        if (!present[i]) await unlink(side).catch(() => {});
    },
  };
}

// Reads a workspace without changing it: the write-ahead log is inspected
// in place (read only), the database and its log are examined as copies in
// a scratch folder, and objects are read in place. Suitable for a workspace
// the service refuses to open.
export async function diagnoseWorkspace(
  root: string,
  options: { verifyObjects?: boolean; scratch?: string } = {},
) {
  const file = await safePath(root, "workspace.sqlite");
  const size = async (p: string) =>
    (await lstat(p).catch(() => null))?.size ?? null;
  const report = {
    database: {
      bytes: await size(file),
      walBytes: await size(`${file}-wal`),
      shmBytes: await size(`${file}-shm`),
      wal: await inspectWal(`${file}-wal`),
      schemaVersion: null as number | null,
      integrity: null as string[] | null,
      error: null as string | null,
    },
    projects: [] as Head[],
    objects: {
      ready: 0,
      quarantined: 0,
      missing: [] as ObjectRow[],
      mismatched: [] as ObjectRow[],
      invalid: [] as ObjectRow[],
      verified: 0,
    },
    unregisteredFiles: 0,
  };
  if (report.database.bytes === null) {
    report.database.error = "workspace.sqlite is missing.";
    return report;
  }
  const scratchParent = options.scratch ?? tmpdir();
  if (
    (await freeBytes(scratchParent)) <
    report.database.bytes + (report.database.walBytes ?? 0) + 64 * 1024 * 1024
  )
    throw new CommandError(
      "LIMIT_EXCEEDED",
      "Not enough free space in the scratch folder to examine a copy of the database; choose another with --scratch.",
    );
  const scratch = await mkdtemp(path.join(scratchParent, "yamakan-diagnose-"));
  try {
    const copy = path.join(scratch, "workspace.sqlite");
    await copyFile(file, copy);
    if (report.database.walBytes !== null)
      await copyFile(`${file}-wal`, `${copy}-wal`);
    let db: DatabaseSync | null = null;
    let rows: {
      project_id: string;
      digest: string;
      byte_length: number;
      state: string;
    }[] = [];
    try {
      db = new DatabaseSync(copy);
      report.database.schemaVersion = userVersion(db);
      report.database.integrity = integrity(db) ?? ["ok"];
      report.projects = heads(db);
      rows = db
        .prepare(
          "SELECT project_id, digest, byte_length, state FROM asset_objects ORDER BY project_id, digest",
        )
        .all() as typeof rows;
    } catch (e) {
      report.database.error = (e as Error).message;
    } finally {
      db?.close();
    }
    const registered = new Set(rows.map((r) => `${r.project_id}/${r.digest}`));
    for (const row of rows) {
      if (row.state === "quarantined") report.objects.quarantined++;
      if (row.state !== "ready") continue;
      report.objects.ready++;
      const object = {
        projectId: row.project_id,
        digest: row.digest,
        bytes: row.byte_length,
      };
      if (malformed(object)) {
        report.objects.invalid.push(object);
        continue;
      }
      const source = await sourceObject(root, row.project_id, row.digest);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile()) report.objects.missing.push(object);
      else if (info.size !== row.byte_length)
        report.objects.mismatched.push(object);
      else if (options.verifyObjects) {
        if ((await sha256File(source)) === row.digest)
          report.objects.verified++;
        else report.objects.mismatched.push(object);
      }
    }
    const projectsDir = await safePath(root, "projects");
    for (const id of await readdir(projectsDir).catch(() => [] as string[])) {
      if (!Id.safeParse(id).success) continue;
      const top = await safePath(projectsDir, id, "objects", "sha256");
      for (const prefix of await readdir(top).catch(() => [] as string[]))
        for (const digest of await readdir(path.join(top, prefix)).catch(
          () => [] as string[],
        ))
          if (
            /^[0-9a-f]{64}$/.test(digest) &&
            !registered.has(`${id}/${digest}`)
          )
            report.unregisteredFiles++;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return report;
}

// Whether a diagnosis found nothing wrong.
export const healthy = (r: Awaited<ReturnType<typeof diagnoseWorkspace>>) =>
  !r.database.error &&
  !r.database.wal?.damaged &&
  r.database.integrity?.[0] === "ok" &&
  r.objects.missing.length === 0 &&
  r.objects.mismatched.length === 0 &&
  r.objects.invalid.length === 0;
