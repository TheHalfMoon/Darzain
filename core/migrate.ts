// Legacy Darzain workspace → new Yamakan workspace (plan T3, contract
// "Legacy migration"). The source root is only read: its complete file
// manifest (paths, sizes, SHA-256) is recorded before and verified after the
// migration. The new workspace is built in a sibling staging folder and only
// renamed to the requested destination once the source is verified
// unchanged, so a failed run never leaves a usable half-built workspace at the
// destination. Each verified revision keeps its original number; media bytes
// are re-verified by hash. Projects that cannot be migrated are reported and
// skipped, never adopted silently.
import { restrictToOwner } from "./process/access.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { LegacyProjectStore } from "./legacy-store.ts";
import { EDIT_VIEW_FORMAT, ProjectStore } from "./store.ts";
import {
  FORMAT,
  FORMAT_VERSION,
  fromEditView,
  inspectFormat,
  parseCanonical,
} from "./canonical.ts";
import type { CanonicalProject } from "./canonical.ts";
import type { Asset, Project } from "./project.ts";
import { Id, ProjectSchema } from "./project.ts";
import { acquireServiceLock } from "./service-lock.ts";
import { canonicalJson, sha256Hex } from "./donors/ninerr/canonical.ts";
import { CommandError, toCommandError } from "./command/errors.ts";

const MAX_SOURCE_FILES = 200_000;

export type ManifestEntry = { path: string; bytes: number; sha256: string };
export type ProjectOutcome = {
  projectId: string;
  status: "migrated" | "skipped";
  reason: string | null;
  headRevision: number | null;
  migratedRevisions: number[];
  unverifiedRevisions: number[];
  // Verified revisions newer than the accepted head, which are not migrated.
  revisionsAfterHead: number[];
  objects: number;
  // True only when the caller accepted the latest verified revision because
  // the legacy head itself could not be verified.
  headReplacedByLatestVerified: boolean;
};
export type MigrationReport = {
  report: "yamakan.migration/1";
  sourceFormat: "darzain.workspace/1";
  sourceManifestSha256: string;
  sourceFiles: number;
  sourceUnchanged: boolean;
  projects: ProjectOutcome[];
};

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

// A pre-database workspace: any project folder with a legacy head file. The
// database store never writes head files, so this also recognizes a legacy
// root that an earlier build opened in place (it may hold workspace.sqlite).
export async function isLegacyWorkspace(root: string) {
  const projects = path.join(root, "projects");
  if (!(await exists(projects))) return false;
  for (const id of await readdir(projects))
    if (
      Id.safeParse(id).success &&
      (await exists(path.join(projects, id, "head.json")))
    )
      return true;
  return false;
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

const byName = (a: { name: string }, b: { name: string }) => {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
};

// Every regular file under root, sorted; links and other special entries are
// refused rather than followed.
export async function manifest(root: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      byName,
    )) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink())
        throw new CommandError(
          "VALIDATION",
          `Source contains a link, which migration does not follow: ${rel}`,
        );
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        if (out.length >= MAX_SOURCE_FILES)
          throw new CommandError(
            "LIMIT_EXCEEDED",
            "Source workspace has too many files.",
          );
        out.push({ path: rel, ...(await hashFile(full)) });
      } else
        throw new CommandError(
          "VALIDATION",
          `Source contains a special file: ${rel}`,
        );
    }
  };
  await walk(root);
  return out;
}

export async function sourceDigest(root: string) {
  return sha256Hex(canonicalJson(await manifest(root)));
}

// Read-only access to a legacy media object. Only a regular file is read; the
// destination store hashes the stream and the caller compares it with the
// asset's recorded identity.
type MediaRef = Pick<Asset, "id" | "hash" | "extension" | "bytes">;
async function* legacyAsset(
  source: string,
  projectId: string,
  asset: MediaRef,
) {
  const candidates = [
    ["objects", "sha256", asset.hash.slice(0, 2), asset.hash],
    ["assets", `${asset.hash}.${asset.extension}`],
  ];
  for (const parts of candidates) {
    const file = path.join(source, "projects", projectId, ...parts);
    const info = await lstat(file, { bigint: true }).catch(() => null);
    if (!info) continue;
    const notRegular = new CommandError(
      "VALIDATION",
      `Media object is not a regular file: projects/${projectId}/${parts.join("/")}`,
    );
    if (!info.isFile()) throw notRegular;
    // Read through the opened handle, and only if it is the file lstat saw.
    const handle = await open(file, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw notRegular;
      yield* handle.createReadStream({
        autoClose: false,
      }) as AsyncIterable<Uint8Array>;
    } finally {
      await handle.close();
    }
    return;
  }
  throw new CommandError(
    "RECOVERY_REQUIRED",
    `Media object ${asset.hash} of asset ${asset.id} is missing.`,
  );
}

async function migrateProject(
  legacy: LegacyProjectStore,
  destination: ProjectStore,
  source: string,
  projectId: string,
  acceptLatestVerified: boolean,
  outcome: ProjectOutcome,
) {
  const history = await legacy.history(projectId);
  outcome.unverifiedRevisions = history.snapshots
    .filter((s) => !s.verified)
    .map((s) => s.revision)
    .sort((a, b) => a - b);
  const verified = history.snapshots
    .filter((s) => s.verified)
    .map((s) => s.revision)
    .sort((a, b) => a - b);
  if (!verified.length) {
    outcome.reason = "No revision of this project can be verified.";
    return;
  }
  let head = history.currentRevision;
  if (head === null) {
    if (!acceptLatestVerified) {
      outcome.reason =
        "The legacy head cannot be verified; rerun with acceptance of the latest verified revision.";
      return;
    }
    head = verified[verified.length - 1];
    outcome.headReplacedByLatestVerified = true;
  }
  const accepted = head;
  outcome.revisionsAfterHead = verified.filter((r) => r > accepted);
  const current =
    history.currentRevision !== null ? await legacy.load(projectId) : null;
  const revisions: Project[] = [];
  for (const revision of verified.filter((r) => r <= accepted))
    revisions.push(
      current?.revision === revision
        ? current
        : await legacy.readRevision(projectId, revision),
    );
  const canonical: CanonicalProject[] = revisions.map((p) => fromEditView(p));
  // Publish every referenced media object before any snapshot references it.
  const assets = new Map<string, Asset>();
  for (const p of revisions) for (const a of p.assets) assets.set(a.hash, a);
  for (const asset of assets.values()) {
    const stored = await destination.importObject(
      projectId,
      legacyAsset(source, projectId, asset),
    );
    if (stored.sha256 !== asset.hash || stored.byteLength !== asset.bytes)
      throw new CommandError(
        "RECOVERY_REQUIRED",
        `Media object of asset ${asset.id} does not match its recorded hash.`,
      );
  }
  destination.importHistory(projectId, canonical);
  outcome.status = "migrated";
  outcome.headRevision = accepted;
  outcome.migratedRevisions = canonical.map((p) => p.revision);
  outcome.objects = assets.size;
}

// Projects that exist only in the database of a legacy root an earlier build
// opened in place. The database is read from a private copy (with its
// write-ahead log), so the source is never opened, locked or written.
async function copySourceDatabase(source: string, into: string) {
  const file = path.join(source, "workspace.sqlite");
  if (!(await exists(file))) return null;
  await mkdir(into, { recursive: true });
  for (const suffix of ["", "-wal"]) {
    const info = await lstat(file + suffix).catch(() => null);
    if (!info) continue;
    if (!info.isFile())
      throw new CommandError(
        "VALIDATION",
        "Source database is not a regular file.",
      );
    await copyFile(file + suffix, path.join(into, "workspace.sqlite" + suffix));
  }
  return new DatabaseSync(path.join(into, "workspace.sqlite"));
}

async function migrateDatabaseProject(
  db: DatabaseSync,
  destination: ProjectStore,
  source: string,
  projectId: string,
  acceptLatestVerified: boolean,
  outcome: ProjectOutcome,
) {
  const head = db
    .prepare(
      "SELECT revision, snapshot_hash FROM projects WHERE project_id = ?",
    )
    .get(projectId) as { revision: number; snapshot_hash: string } | undefined;
  const rows = db
    .prepare(
      "SELECT r.revision, r.snapshot_hash, s.format, s.bytes FROM revisions r LEFT JOIN snapshots s ON s.hash = r.snapshot_hash WHERE r.project_id = ? ORDER BY r.revision",
    )
    .all(projectId) as {
    revision: number;
    snapshot_hash: string;
    format: string | null;
    bytes: Uint8Array | null;
  }[];
  const decoded = new Map<number, CanonicalProject>();
  let newerFormat = false;
  for (const row of rows) {
    try {
      if (!row.bytes) throw new Error("missing");
      const text = Buffer.from(row.bytes).toString("utf8");
      if (sha256Hex(text) !== row.snapshot_hash) throw new Error("hash");
      const value: unknown = JSON.parse(text);
      const info = inspectFormat(value);
      if (info.format === FORMAT && (info.formatVersion ?? 0) > FORMAT_VERSION)
        newerFormat = true;
      const project =
        row.format === EDIT_VIEW_FORMAT
          ? fromEditView(ProjectSchema.parse(value))
          : parseCanonical(value);
      if (project.id !== projectId || project.revision !== row.revision)
        throw new Error("identity");
      decoded.set(row.revision, project);
    } catch {
      outcome.unverifiedRevisions.push(row.revision);
    }
  }
  // Never replace a newer build's work with an older revision, even on request.
  if (newerFormat) {
    outcome.reason =
      "The project has revisions in a newer format; migrate it with a newer build.";
    return;
  }
  const verified = [...decoded.keys()].sort((a, b) => a - b);
  if (!verified.length) {
    outcome.reason = "No revision of this project can be verified.";
    return;
  }
  let accepted = head?.revision ?? -1;
  if (!head || !decoded.has(head.revision)) {
    if (!acceptLatestVerified) {
      outcome.reason =
        "The project head cannot be verified; rerun with acceptance of the latest verified revision.";
      return;
    }
    accepted = verified[verified.length - 1];
    outcome.headReplacedByLatestVerified = true;
  }
  outcome.revisionsAfterHead = verified.filter((r) => r > accepted);
  const canonical = verified
    .filter((r) => r <= accepted)
    .map((r) => decoded.get(r)!);
  const assets = new Map<string, MediaRef>();
  for (const p of canonical) for (const a of p.assets) assets.set(a.hash, a);
  for (const asset of assets.values()) {
    const stored = await destination.importObject(
      projectId,
      legacyAsset(source, projectId, asset),
    );
    if (stored.sha256 !== asset.hash || stored.byteLength !== asset.bytes)
      throw new CommandError(
        "RECOVERY_REQUIRED",
        `Media object of asset ${asset.id} does not match its recorded hash.`,
      );
  }
  destination.importHistory(projectId, canonical);
  outcome.status = "migrated";
  outcome.headRevision = accepted;
  outcome.migratedRevisions = canonical.map((p) => p.revision);
  outcome.objects = assets.size;
}

// Filesystem identity of an existing path (volume serial + file index on NTFS).
async function identity(p: string) {
  const s = await stat(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
}
async function ancestors(p: string) {
  const out: string[] = [];
  for (let cursor = p; ; cursor = path.dirname(cursor)) {
    out.push(cursor);
    if (path.dirname(cursor) === cursor) return out;
  }
}
// Nearest existing ancestor of a path, resolved through links and aliases.
async function nearestReal(p: string) {
  for (const candidate of await ancestors(p))
    if (await exists(candidate)) return realpath(candidate);
  throw new CommandError("VALIDATION", "Destination has no existing ancestor.");
}

// Source and destination must not overlap by any spelling: compare real
// paths and also filesystem identities of every ancestor, which catches
// junctions, subst drives, 8.3 short names and UNC aliases.
async function assertSeparate(source: string, destination: string) {
  if (/^(\\\\|\/\/)/.test(destination))
    throw new CommandError(
      "VALIDATION",
      "Network and device paths are not supported as a destination.",
    );
  const realSource = await realpath(source);
  const sourceId = await identity(realSource);
  const destinationBase = await nearestReal(destination);
  const destinationIds = await Promise.all(
    (await ancestors(destinationBase)).map((p) =>
      identity(p).catch(() => null),
    ),
  );
  if (destinationIds.includes(sourceId))
    throw new CommandError(
      "VALIDATION",
      "Source and destination must be separate folders.",
    );
  if (await exists(destination)) {
    const destinationId = await identity(await realpath(destination));
    const sourceAncestors = await Promise.all(
      (await ancestors(realSource)).map((p) => identity(p).catch(() => null)),
    );
    if (sourceAncestors.includes(destinationId))
      throw new CommandError(
        "VALIDATION",
        "Source and destination must be separate folders.",
      );
  }
}

// The report is written even when the run fails; paths are relative.
async function writeReport(
  staging: string,
  before: ManifestEntry[],
  report: MigrationReport,
) {
  await mkdir(path.join(staging, "migration"), { recursive: true });
  await writeFile(
    path.join(staging, "migration", "source-manifest.json"),
    `${JSON.stringify(before, null, 2)}\n`,
  );
  await writeFile(
    path.join(staging, "migration", "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

const safeMessage = (e: unknown, ...roots: string[]) =>
  roots.reduce(
    (message, root) => message.replaceAll(root, "[workspace]"),
    toCommandError(e).message,
  );

export async function migrateLegacyWorkspace(
  sourceRoot: string,
  destinationRoot: string,
  options: { acceptLatestVerified?: boolean } = {},
): Promise<MigrationReport> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!(await isLegacyWorkspace(source)))
    throw new CommandError(
      "VALIDATION",
      "Source is not a legacy Darzain workspace.",
    );
  await assertSeparate(source, destination);
  if ((await exists(destination)) && (await readdir(destination)).length)
    throw new CommandError(
      "VALIDATION",
      "Destination must be a new or empty folder.",
    );
  const staging = path.join(
    path.dirname(destination),
    `${path.basename(destination)}.migrating-${randomUUID().slice(0, 8)}`,
  );
  await assertSeparate(source, staging);
  const before = await manifest(source);
  const beforeHash = sha256Hex(canonicalJson(before));

  await mkdir(path.dirname(staging), { recursive: true });
  await mkdir(staging);
  const report: MigrationReport = {
    report: "yamakan.migration/1",
    sourceFormat: "darzain.workspace/1",
    sourceManifestSha256: beforeHash,
    sourceFiles: before.length,
    sourceUnchanged: false,
    projects: [],
  };
  try {
    // Private before any project data is written into it.
    await restrictToOwner(staging, "dir");
    const lock = await acquireServiceLock(staging);
    const store = new ProjectStore(staging);
    try {
      await store.initialize();
      // Read paths only: no initialize(), save, restore or import on the source.
      const legacy = new LegacyProjectStore(source);
      const databaseCopy = path.join(staging, "migration", "source-database");
      const sourceDb = await copySourceDatabase(source, databaseCopy);
      const databaseIds = new Set(
        (
          (sourceDb?.prepare("SELECT project_id FROM projects").all() ??
            []) as { project_id: string }[]
        ).map((r) => r.project_id),
      );
      const ids = [
        ...new Set([
          ...(await readdir(path.join(source, "projects"))),
          ...databaseIds,
        ]),
      ]
        .filter((id) => Id.safeParse(id).success)
        .sort();
      try {
        for (const projectId of ids) {
          const outcome: ProjectOutcome = {
            projectId,
            status: "skipped",
            reason: null,
            headRevision: null,
            migratedRevisions: [],
            unverifiedRevisions: [],
            revisionsAfterHead: [],
            objects: 0,
            headReplacedByLatestVerified: false,
          };
          try {
            const hasHead = await exists(
              path.join(source, "projects", projectId, "head.json"),
            );
            if (!hasHead && sourceDb && databaseIds.has(projectId))
              await migrateDatabaseProject(
                sourceDb,
                store,
                source,
                projectId,
                options.acceptLatestVerified === true,
                outcome,
              );
            else
              await migrateProject(
                legacy,
                store,
                source,
                projectId,
                options.acceptLatestVerified === true,
                outcome,
              );
          } catch (e) {
            // One unreadable project never aborts the others. Its objects may
            // remain in staging unreferenced; no snapshot points at them.
            outcome.status = "skipped";
            outcome.reason = safeMessage(e, source, staging);
          }
          report.projects.push(outcome);
        }
      } finally {
        sourceDb?.close();
        await rm(databaseCopy, { recursive: true, force: true });
      }
    } finally {
      store.close();
      lock.release();
    }
    report.sourceUnchanged =
      sha256Hex(canonicalJson(await manifest(source))) === beforeHash;
  } catch (e) {
    // A failed write of the report never hides the original error.
    await writeReport(staging, before, report).catch(() => {});
    const error = toCommandError(e);
    throw new CommandError(
      error.code,
      `${safeMessage(error, source, staging)} The unpublished result is in ${path.basename(staging)} and can be deleted.`,
    );
  }
  await writeReport(staging, before, report);
  if (!report.sourceUnchanged)
    throw new CommandError(
      "RECOVERY_REQUIRED",
      `The source workspace changed during migration; the unpublished result is in ${path.basename(staging)} and can be deleted.`,
    );
  // Publish: the destination appears only once complete and verified.
  if (await exists(destination)) await rmdir(destination);
  await rename(staging, destination);
  return report;
}
