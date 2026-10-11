// Legacy Darzain workspace → new Yamakan workspace (plan T3, contract
// "Legacy migration"). The source root is only read: its complete file
// manifest (paths, sizes, SHA-256) is recorded before and verified after the
// migration, and the migration fails if any byte changed. Each verified
// revision becomes a canonical snapshot with its original revision number;
// media bytes are re-verified by hash and published into the destination's
// content-addressed store. Nothing is adopted silently: projects whose head
// cannot be verified are reported and skipped unless the caller explicitly
// accepts their latest verified revision.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { LegacyProjectStore } from "./legacy-store.ts";
import { ProjectStore } from "./store.ts";
import { fromEditView } from "./canonical.ts";
import type { CanonicalProject } from "./canonical.ts";
import type { Asset, Project } from "./project.ts";
import { Id } from "./project.ts";
import { acquireServiceLock } from "./service-lock.ts";
import { canonicalJson, sha256Hex } from "./donors/ninerr/canonical.ts";
import { CommandError } from "./command/errors.ts";

const MAX_SOURCE_FILES = 200_000;

export type ManifestEntry = { path: string; bytes: number; sha256: string };
export type ProjectOutcome = {
  projectId: string;
  status: "migrated" | "skipped";
  reason: string | null;
  headRevision: number | null;
  migratedRevisions: number[];
  unverifiedRevisions: number[];
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

// A pre-database workspace: project folders with head files and no database.
export async function isLegacyWorkspace(root: string) {
  if (await exists(path.join(root, "workspace.sqlite"))) return false;
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

// Every regular file under root, sorted; links and other special entries are
// refused rather than followed.
export async function manifest(root: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
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

// Read-only access to a legacy media object; the destination store hashes
// the stream and the caller compares it with the asset's recorded identity.
async function* legacyAsset(source: string, projectId: string, asset: Asset) {
  const candidates = [
    path.join(
      source,
      "projects",
      projectId,
      "objects",
      "sha256",
      asset.hash.slice(0, 2),
      asset.hash,
    ),
    path.join(
      source,
      "projects",
      projectId,
      "assets",
      `${asset.hash}.${asset.extension}`,
    ),
  ];
  for (const file of candidates) {
    if (!(await exists(file))) continue;
    yield* createReadStream(file) as AsyncIterable<Uint8Array>;
    return;
  }
  throw new Error("Asset not found.");
}

async function migrateProject(
  legacy: LegacyProjectStore,
  destination: ProjectStore,
  source: string,
  projectId: string,
  acceptLatestVerified: boolean,
): Promise<ProjectOutcome> {
  const outcome: ProjectOutcome = {
    projectId,
    status: "skipped",
    reason: null,
    headRevision: null,
    migratedRevisions: [],
    unverifiedRevisions: [],
    objects: 0,
    headReplacedByLatestVerified: false,
  };
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
    return outcome;
  }
  let head = history.currentRevision;
  if (head === null) {
    if (!acceptLatestVerified) {
      outcome.reason =
        "The legacy head cannot be verified; rerun with acceptance of the latest verified revision.";
      return outcome;
    }
    head = verified[verified.length - 1];
    outcome.headReplacedByLatestVerified = true;
  }
  const current =
    history.currentRevision !== null ? await legacy.load(projectId) : null;
  const revisions: Project[] = [];
  for (const revision of verified.filter((r) => r <= head!))
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
      throw new Error("Asset integrity check failed.");
  }
  destination.importHistory(projectId, canonical);
  outcome.status = "migrated";
  outcome.headRevision = head;
  outcome.migratedRevisions = canonical.map((p) => p.revision);
  outcome.objects = assets.size;
  return outcome;
}

export async function migrateLegacyWorkspace(
  sourceRoot: string,
  destinationRoot: string,
  options: { acceptLatestVerified?: boolean } = {},
): Promise<MigrationReport> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const inside = (a: string, b: string) => {
    const rel = path.relative(a, b);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(source, destination) || inside(destination, source))
    throw new CommandError(
      "VALIDATION",
      "Source and destination must be separate folders.",
    );
  if (!(await isLegacyWorkspace(source)))
    throw new CommandError(
      "VALIDATION",
      "Source is not a legacy Darzain workspace.",
    );
  if ((await exists(destination)) && (await readdir(destination)).length)
    throw new CommandError(
      "VALIDATION",
      "Destination must be a new or empty folder.",
    );
  const before = await manifest(source);
  const beforeHash = sha256Hex(canonicalJson(before));

  await mkdir(destination, { recursive: true });
  const lock = await acquireServiceLock(destination);
  const store = new ProjectStore(destination);
  const projects: ProjectOutcome[] = [];
  try {
    await store.initialize();
    // Read paths only: no initialize(), save, restore or import on the source.
    const legacy = new LegacyProjectStore(source);
    const ids = (await readdir(path.join(source, "projects")))
      .filter((id) => Id.safeParse(id).success)
      .sort();
    for (const id of ids)
      projects.push(
        await migrateProject(
          legacy,
          store,
          source,
          id,
          options.acceptLatestVerified === true,
        ),
      );
  } finally {
    store.close();
    lock.release();
  }

  const after = await manifest(source);
  const report: MigrationReport = {
    report: "yamakan.migration/1",
    sourceFormat: "darzain.workspace/1",
    sourceManifestSha256: beforeHash,
    sourceFiles: before.length,
    sourceUnchanged: sha256Hex(canonicalJson(after)) === beforeHash,
    projects,
  };
  // The report holds relative paths and hashes only, never absolute paths.
  await mkdir(path.join(destination, "migration"), { recursive: true });
  await writeFile(
    path.join(destination, "migration", "source-manifest.json"),
    `${JSON.stringify(before, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(destination, "migration", "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  if (!report.sourceUnchanged)
    throw new CommandError(
      "RECOVERY_REQUIRED",
      "The source workspace changed during migration; the destination is not authoritative.",
    );
  return report;
}

export async function sourceDigest(root: string) {
  return sha256Hex(canonicalJson(await manifest(root)));
}
