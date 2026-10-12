// Recovery (plan T9): online workspace backups, restore into a new root and
// read-only diagnosis. A backup is a database copy taken online plus every
// ready content object it registers, each re-hashed as it is copied, and a
// manifest written last; a folder without a manifest is not a backup.
// Restore never writes into an existing workspace: it builds a new root,
// verifies every byte against the manifest and the content addresses, and
// quarantines what it cannot verify instead of failing the whole restore.
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
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Id } from "./project.ts";
import { initializeRoot, safePath } from "./paths.ts";
import { CommandError } from "./command/errors.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";
import type { ProjectStore } from "./store.ts";

export const BACKUP_FORMAT = "yamakan.backup/1";
export const RESTORE_FORMAT = "yamakan.restore/1";
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const BackupId = z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);

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

const ManifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupId: BackupId,
    createdAt: z.string().max(40),
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
          projectId: Id,
          digest: Digest,
          reason: z.enum(["missing", "mismatch"]),
        })
        .strict(),
    ),
    excluded: z.array(z.string().max(80)),
  })
  .strict();
export type BackupManifest = z.infer<typeof ManifestSchema>;

type Head = { projectId: string; revision: number; snapshotHash: string };
type ObjectRow = { projectId: string; digest: string; bytes: number };

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
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
// Neither folder may contain the other: a backup inside the workspace
// would copy itself, and a workspace inside the backups would be backed up
// with them.
async function separate(root: string, other: string) {
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

const freeBytes = async (dir: string) => {
  const space = await statfs(dir);
  return Number(space.bavail) * Number(space.bsize);
};

export function defaultRecoveryHome(root: string) {
  return path.join(path.dirname(root), `${path.basename(root)}-recovery`);
}

let backingUp = false;

// Backs up a running workspace into `<home>/backups/<id>`. Edits, imports
// and jobs continue meanwhile; the backup is the state at the moment its
// database copy completed.
export async function backupWorkspace(
  store: ProjectStore,
  home: string,
  options: { now?: Date } = {},
) {
  if (backingUp)
    throw new CommandError("BUSY", "A backup is already running; retry.");
  backingUp = true;
  const release = store.holdObjects();
  let dir: string | null = null;
  try {
    const now = options.now ?? new Date();
    const backupId = `${now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "")}-${randomBytes(4).toString("hex")}`;
    await separate(store.root, home);
    const backups = path.join(home, "backups");
    await mkdir(backups, { recursive: true });
    dir = path.join(backups, backupId);
    await mkdir(dir);
    const database = path.join(dir, "workspace.sqlite");
    await store.backupDatabase(database);
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
      schemaVersion = (
        copy.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      projects = heads(copy);
      objects = readyObjects(copy);
    } finally {
      copy.close();
    }
    const needed =
      objects.reduce((n, o) => n + o.bytes, 0) +
      RESOURCE_POLICY.enforced.diskReserveBytes;
    if ((await freeBytes(dir)) < needed)
      throw new CommandError(
        "LIMIT_EXCEEDED",
        "Not enough free disk space for this backup.",
      );
    const copied: ObjectRow[] = [];
    const damaged: BackupManifest["damaged"] = [];
    for (const object of objects) {
      const result = await copyVerified(
        await sourceObject(store.root, object.projectId, object.digest),
        await safePath(dir, ...objectParts(object.projectId, object.digest)),
        { sha256: object.digest, bytes: object.bytes },
      );
      if (result === "ok") copied.push(object);
      else
        damaged.push({
          projectId: object.projectId,
          digest: object.digest,
          reason: result,
        });
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
    backingUp = false;
  }
}

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
  return ManifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, "backup.json"), "utf8")),
  );
}

// Backups in a recovery home, newest first. A folder without a valid
// manifest is listed as incomplete and cannot be restored.
export async function listBackups(home: string) {
  const backups = path.join(home, "backups");
  const result: (
    ReturnType<typeof summary> | { backupId: string; complete: false }
  )[] = [];
  for (const name of await readdir(backups).catch(() => [] as string[])) {
    if (!BackupId.safeParse(name).success) continue;
    try {
      const manifest = await readManifest(path.join(backups, name));
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
export async function restoreWorkspace(backupDir: string, newRoot: string) {
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
  const existing = await readdir(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  });
  if (existing.length > 0)
    throw new CommandError(
      "VALIDATION",
      "Restore destination must be a new, empty folder.",
    );
  await initializeRoot(root);
  await separate(root, backupDir);
  try {
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
    const quarantined: BackupManifest["damaged"] = [...manifest.damaged];
    let verified = 0;
    for (const object of manifest.objects) {
      const parts = objectParts(object.projectId, object.digest);
      const result = await copyVerified(
        await safePath(backupDir, ...parts),
        await safePath(root, ...parts),
        { sha256: object.digest, bytes: object.bytes },
      );
      if (result === "ok") verified++;
      else
        quarantined.push({
          projectId: object.projectId,
          digest: object.digest,
          reason: result,
        });
    }
    const db = new DatabaseSync(database);
    let restored: Head[];
    try {
      const problems = integrity(db);
      if (problems)
        throw new CommandError(
          "RECOVERY_REQUIRED",
          `The restored database failed its integrity check: ${problems[0]}`,
        );
      restored = heads(db);
      if (JSON.stringify(restored) !== JSON.stringify(manifest.projects))
        throw new CommandError(
          "RECOVERY_REQUIRED",
          "The restored project heads do not match the backup manifest.",
        );
      // What could not be verified is kept registered but never served.
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
    // The destination was empty (or absent) and everything in it is ours.
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// Restores a backup of a recovery home into a fresh folder of that home.
export async function restoreFromHome(home: string, backupId: string) {
  const id = BackupId.parse(backupId);
  const dir = path.join(home, "backups", id);
  if (!(await lstat(dir).catch(() => null))?.isDirectory())
    throw new CommandError("NOT_FOUND", "Backup not found.");
  const restored = path.join(home, "restored");
  await mkdir(restored, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const target = path.join(restored, `${id}-${n}`);
    try {
      await mkdir(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    return restoreWorkspace(dir, target);
  }
  throw new CommandError("LIMIT_EXCEEDED", "Too many restores of this backup.");
}

// Reads a workspace without changing it: the database (and its write-ahead
// log) are examined as copies in a temporary folder, and objects are read
// in place. Suitable for a workspace the service refuses to open.
export async function diagnoseWorkspace(
  root: string,
  options: { verifyObjects?: boolean } = {},
) {
  const file = await safePath(root, "workspace.sqlite");
  const size = async (p: string) =>
    (await lstat(p).catch(() => null))?.size ?? null;
  const report = {
    database: {
      bytes: await size(file),
      walBytes: await size(`${file}-wal`),
      shmBytes: await size(`${file}-shm`),
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
      verified: 0,
    },
    unregisteredFiles: 0,
  };
  if (report.database.bytes === null) {
    report.database.error = "workspace.sqlite is missing.";
    return report;
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "yamakan-diagnose-"));
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
      report.database.schemaVersion = (
        db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
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
