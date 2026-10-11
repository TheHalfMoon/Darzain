import { mkdir, readdir, writeFile, unlink, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "./donors/ninerr/canonical.ts";
import { ProjectSchema, Id, AssetSchema, createProject } from "./project.ts";
import type { Project, Asset } from "./project.ts";
import { safePath, initializeRoot } from "./paths.ts";
import { mediaHeader, MAX_ASSET_BYTES, probe } from "./media.ts";
import { readBounded } from "./durable.ts";
import { LocalContentAddressedStorage } from "./donors/skelet/storage.ts";
import { CommandError } from "./command/errors.ts";
import { RESOURCE_POLICY } from "./command/policy.ts";

export type ProjectHistory = {
  projectId: string;
  headFingerprint: string | null;
  currentRevision: number | null;
  snapshots: {
    revision: number;
    name: string | null;
    verified: boolean;
    error: string | null;
  }[];
};

// Identifies a client request for idempotent replay (operational contracts,
// "Commit algorithm"). The digest covers the operation and its complete input.
export type RequestReceipt = {
  principalId: string;
  requestId: string;
  digest: string;
};

export type FaultPoint =
  "after-snapshot-insert" | "before-commit" | "after-commit";
export type StoreOptions = { fault?: (point: FaultPoint) => void };

const SNAPSHOT_FORMAT = "yamakan.project/v1";
const MAX_REVISION = 10000;
const SCHEMA_VERSION = 1;
const WORKSPACE_SCOPE = "";

const SCHEMA = `
CREATE TABLE snapshots(
  hash TEXT PRIMARY KEY CHECK(length(hash) = 64),
  format TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length = length(bytes))
) STRICT;
CREATE TABLE projects(
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  snapshot_hash TEXT NOT NULL REFERENCES snapshots(hash)
) STRICT;
CREATE TABLE command_receipts(
  id INTEGER PRIMARY KEY,
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result BLOB NOT NULL,
  committed_revision INTEGER NOT NULL,
  UNIQUE(principal_id, project_id, request_id)
) STRICT;
CREATE TABLE revisions(
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  snapshot_hash TEXT NOT NULL REFERENCES snapshots(hash),
  parent_revision INTEGER,
  operation TEXT NOT NULL,
  receipt_id INTEGER REFERENCES command_receipts(id),
  PRIMARY KEY(project_id, revision)
) STRICT;
CREATE TABLE outbox(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL
) STRICT;
`;

type Head = { revision: number; snapshot_hash: string };
type Commit = {
  operation: string;
  projectId: string;
  // null: apply to whatever head is current (commutative appends such as asset import).
  expectedRevision: number | null;
  receipt?: RequestReceipt;
  // Precondition evaluated inside the transaction, before any write.
  check?: (head: Head) => void;
  next: (current: () => Project, revision: number) => Project;
};

const isBusy = (e: unknown) =>
  e instanceof Error && /database is locked|SQLITE_BUSY/i.test(e.message);

export class ProjectStore {
  readonly root: string;
  readonly #options: StoreOptions;
  #db: DatabaseSync | null = null;
  constructor(root: string, options: StoreOptions = {}) {
    this.root = root;
    this.#options = options;
  }
  get #database() {
    if (!this.#db) throw new CommandError("UNAVAILABLE", "Store is closed.");
    return this.#db;
  }
  async initialize() {
    await initializeRoot(this.root);
    await mkdir(await safePath(this.root, "projects"), { recursive: true });
    const db = new DatabaseSync(await safePath(this.root, "workspace.sqlite"), {
      enableForeignKeyConstraints: true,
    });
    try {
      db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );
      const integrity = db.prepare("PRAGMA quick_check").all();
      if (
        integrity.length !== 1 ||
        (integrity[0] as { quick_check: string }).quick_check !== "ok"
      )
        throw new CommandError(
          "RECOVERY_REQUIRED",
          "Workspace database failed its integrity check; restore a verified backup to a new root.",
        );
      const { user_version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version > SCHEMA_VERSION)
        throw new CommandError(
          "RECOVERY_REQUIRED",
          `Workspace database version ${user_version} is newer than this build supports.`,
        );
      if (user_version === 0) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(SCHEMA);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
    } catch (e) {
      db.close();
      throw isBusy(e)
        ? new CommandError("BUSY", "Workspace database is busy.")
        : e;
    }
    this.#db = db;
  }
  close() {
    this.#db?.close();
    this.#db = null;
  }
  async directory(id: string) {
    Id.parse(id);
    return safePath(this.root, "projects", id);
  }
  async file(id: string, ...parts: string[]) {
    return safePath(this.root, "projects", Id.parse(id), ...parts);
  }
  // Media, exports and staging stay outside the database as immutable files.
  async #ensureDirectories(id: string) {
    for (const sub of ["objects", "exports", "imports"])
      await mkdir(await this.file(id, sub), { recursive: true });
  }

  #head(id: string): Head | undefined {
    return this.#database
      .prepare(
        "SELECT revision, snapshot_hash FROM projects WHERE project_id = ?",
      )
      .get(id) as Head | undefined;
  }
  #snapshot(hash: string, id: string, revision: number): Project {
    const row = this.#database
      .prepare("SELECT bytes FROM snapshots WHERE hash = ?")
      .get(hash) as { bytes: Uint8Array } | undefined;
    if (!row) throw new Error("Project snapshot hash mismatch.");
    const text = Buffer.from(row.bytes).toString("utf8");
    if (sha256Hex(text) !== hash)
      throw new Error("Project snapshot hash mismatch.");
    const project = ProjectSchema.parse(JSON.parse(text));
    if (project.id !== id || project.revision !== revision)
      throw new Error("Project snapshot identity mismatch.");
    return project;
  }
  static fingerprint(head: Head) {
    return sha256Hex(`${head.revision}:${head.snapshot_hash}`);
  }

  #commit(c: Commit): Project {
    const db = this.#database;
    const scope =
      c.expectedRevision === null && c.operation === "project.create"
        ? WORKSPACE_SCOPE
        : c.projectId;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      throw isBusy(e)
        ? new CommandError("BUSY", "Workspace database is busy; retry.")
        : e;
    }
    try {
      // Replay is checked before the revision so a retry after a lost response
      // returns its own committed result instead of a conflict.
      if (c.receipt) {
        const prior = db
          .prepare(
            "SELECT request_digest, result FROM command_receipts WHERE principal_id = ? AND project_id = ? AND request_id = ?",
          )
          .get(c.receipt.principalId, scope, c.receipt.requestId) as
          { request_digest: string; result: Uint8Array } | undefined;
        if (prior) {
          db.exec("ROLLBACK");
          if (prior.request_digest !== c.receipt.digest)
            throw new CommandError(
              "IDEMPOTENCY_MISMATCH",
              "Request ID was already used for a different request.",
            );
          return ProjectSchema.parse(
            JSON.parse(Buffer.from(prior.result).toString("utf8")),
          );
        }
      }
      const head = this.#head(c.projectId);
      if (c.operation === "project.create" ? head : !head)
        throw new CommandError(
          c.operation === "project.create" ? "VALIDATION" : "NOT_FOUND",
          c.operation === "project.create"
            ? "Project already exists."
            : "Project not found.",
        );
      if (
        c.expectedRevision !== null &&
        head &&
        head.revision !== c.expectedRevision
      )
        throw new CommandError(
          "REVISION_CONFLICT",
          "Revision conflict; reopen before saving.",
        );
      if (head) c.check?.(head);
      const revision = head ? head.revision + 1 : 0;
      if (revision > MAX_REVISION)
        throw new CommandError(
          "LIMIT_EXCEEDED",
          "Project history limit reached.",
        );
      // Decoded only on demand: restore must be able to replace a head whose
      // snapshot no longer verifies.
      const current = () => {
        if (!head) throw new Error("Project not found.");
        return this.#snapshot(head.snapshot_hash, c.projectId, head.revision);
      };
      const next = ProjectSchema.parse(c.next(current, revision));
      if (next.id !== c.projectId || next.revision !== revision)
        throw new Error("Project snapshot identity mismatch.");
      const bytes = Buffer.from(canonicalJson(next), "utf8");
      if (bytes.length > RESOURCE_POLICY.enforced.snapshotBytes)
        throw new CommandError(
          "LIMIT_EXCEEDED",
          "Project snapshot exceeds its byte limit.",
        );
      const hash = sha256Hex(bytes);
      db.prepare(
        "INSERT INTO snapshots(hash, format, bytes, byte_length) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
      ).run(hash, SNAPSHOT_FORMAT, bytes, bytes.length);
      this.#options.fault?.("after-snapshot-insert");
      if (head) {
        const moved = db
          .prepare(
            "UPDATE projects SET revision = ?, snapshot_hash = ? WHERE project_id = ? AND revision = ?",
          )
          .run(revision, hash, c.projectId, head.revision);
        if (moved.changes !== 1)
          throw new CommandError(
            "REVISION_CONFLICT",
            "Revision conflict; reopen before saving.",
          );
      } else
        db.prepare(
          "INSERT INTO projects(project_id, revision, snapshot_hash) VALUES (?, ?, ?)",
        ).run(c.projectId, revision, hash);
      const receiptId = c.receipt
        ? Number(
            db
              .prepare(
                "INSERT INTO command_receipts(principal_id, project_id, request_id, request_digest, result, committed_revision) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                c.receipt.principalId,
                scope,
                c.receipt.requestId,
                c.receipt.digest,
                bytes,
                revision,
              ).lastInsertRowid,
          )
        : null;
      db.prepare(
        "INSERT INTO revisions(project_id, revision, snapshot_hash, parent_revision, operation, receipt_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        c.projectId,
        revision,
        hash,
        head?.revision ?? null,
        c.operation,
        receiptId,
      );
      db.prepare(
        "INSERT INTO outbox(project_id, revision, operation) VALUES (?, ?, ?)",
      ).run(c.projectId, revision, c.operation);
      this.#options.fault?.("before-commit");
      db.exec("COMMIT");
      this.#options.fault?.("after-commit");
      return next;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw isBusy(e)
        ? new CommandError("BUSY", "Workspace database is busy; retry.")
        : e;
    }
  }

  async create(name: string, receipt?: RequestReceipt) {
    const draft = createProject(name);
    const p = this.#commit({
      operation: "project.create",
      projectId: draft.id,
      expectedRevision: null,
      receipt,
      next: () => draft,
    });
    await this.#ensureDirectories(p.id);
    return p;
  }
  async load(id: string): Promise<Project> {
    Id.parse(id);
    const head = this.#head(id);
    if (!head) throw new Error("Project not found.");
    return this.#snapshot(head.snapshot_hash, id, head.revision);
  }
  async list() {
    const rows = this.#database
      .prepare("SELECT project_id FROM projects ORDER BY rowid")
      .all() as { project_id: string }[];
    const known = new Set(rows.map((r) => r.project_id));
    const listed = await Promise.all(
      rows.map(async ({ project_id: id }) => {
        try {
          const p = await this.load(id);
          return { id, name: p.name, revision: p.revision, error: null };
        } catch {
          return {
            id,
            name: "Recovery required",
            revision: null,
            error: "Project cannot be verified.",
          };
        }
      }),
    );
    // Pre-database project folders are reported, never silently adopted (T3 migrates them).
    for (const id of await readdir(await safePath(this.root, "projects")))
      if (Id.safeParse(id).success && !known.has(id))
        listed.push({
          id,
          name: "Legacy project",
          revision: null,
          error: "Legacy project requires migration.",
        });
    return listed;
  }
  async history(id: string): Promise<ProjectHistory> {
    Id.parse(id);
    const head = this.#head(id);
    if (!head) throw new Error("Project not found.");
    const rows = this.#database
      .prepare(
        "SELECT revision, snapshot_hash FROM revisions WHERE project_id = ? ORDER BY revision DESC",
      )
      .all(id) as Head[];
    return {
      projectId: id,
      headFingerprint: ProjectStore.fingerprint(head),
      currentRevision: (() => {
        try {
          return this.#snapshot(head.snapshot_hash, id, head.revision).revision;
        } catch {
          return null;
        }
      })(),
      snapshots: rows.map((r) => {
        try {
          const p = this.#snapshot(r.snapshot_hash, id, r.revision);
          return {
            revision: r.revision,
            name: p.name,
            verified: true,
            error: null,
          };
        } catch {
          return {
            revision: r.revision,
            name: null,
            verified: false,
            error: "Snapshot cannot be verified.",
          };
        }
      }),
    };
  }
  async restore(
    id: string,
    revision: number,
    expectedHeadFingerprint: string | null,
    receipt?: RequestReceipt,
  ) {
    Id.parse(id);
    const row = this.#database
      .prepare(
        "SELECT snapshot_hash FROM revisions WHERE project_id = ? AND revision = ?",
      )
      .get(id, revision) as { snapshot_hash: string } | undefined;
    if (!row) throw new Error("Revision not found.");
    const selected = this.#snapshot(row.snapshot_hash, id, revision);
    // Filesystem verification happens before, never inside, the transaction.
    for (const asset of selected.assets) await this.#verifiedAsset(id, asset);
    return this.#commit({
      operation: "project.restore",
      projectId: id,
      expectedRevision: null,
      receipt,
      // A damaged head can still be replaced: the fingerprint covers the head
      // row, not the snapshot bytes it points to.
      check: (head) => {
        if (ProjectStore.fingerprint(head) !== expectedHeadFingerprint)
          throw new CommandError(
            "REVISION_CONFLICT",
            "Revision conflict; refresh history before restoring.",
          );
      },
      next: (_current, next) => ({ ...selected, revision: next }),
    });
  }
  async save(
    input: Project,
    expectedRevision: number,
    receipt?: RequestReceipt,
  ) {
    const proposed = ProjectSchema.parse(input);
    if (proposed.revision !== expectedRevision)
      throw new CommandError(
        "REVISION_CONFLICT",
        "Revision conflict; reopen before saving.",
      );
    return this.#commit({
      operation: "project.save",
      projectId: proposed.id,
      expectedRevision,
      receipt,
      next: (current, revision) => {
        // Asset identities and immutable metadata come only from the validated import path.
        if (canonicalJson(proposed.assets) !== canonicalJson(current().assets))
          throw new CommandError(
            "VALIDATION",
            "Assets must be added through asset.import.",
          );
        return { ...proposed, revision };
      },
    });
  }
  async #objects(id: string) {
    const rootDir = await this.file(id, "objects");
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    return new LocalContentAddressedStorage({
      rootDir,
      maxBytes: MAX_ASSET_BYTES,
    });
  }
  async #verifiedAsset(id: string, asset: Asset) {
    const objectFile = await this.file(
      id,
      "objects",
      "sha256",
      asset.hash.slice(0, 2),
      asset.hash,
    );
    try {
      if ((await (await this.#objects(id)).verify(asset.hash)) !== asset.bytes)
        throw new Error("Asset integrity check failed.");
      return objectFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Pre-content-addressing projects stored media by hash and extension.
      const legacy = await this.file(
        id,
        "assets",
        `${asset.hash}.${asset.extension}`,
      );
      const bytes = await readBounded(legacy, MAX_ASSET_BYTES);
      if (sha256Hex(bytes) !== asset.hash || bytes.length !== asset.bytes)
        throw new Error("Asset integrity check failed.");
      return legacy;
    }
  }
  async importAsset(id: string, name: string, bytes: Buffer) {
    const p = await this.load(id);
    if (p.assets.length >= RESOURCE_POLICY.enforced.assetsPerProject)
      throw new Error("Asset limit reached.");
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES)
      throw new Error("Asset size exceeds limit.");
    const extension = name.split(".").pop()?.toLowerCase() || "";
    mediaHeader(bytes, extension);
    await this.#ensureDirectories(id);
    const assetId = randomUUID();
    const temp = await this.file(id, "imports", `${assetId}.${extension}`);
    const space = await statfs(this.root);
    if (
      Number(space.bavail) * Number(space.bsize) <
      bytes.length + 100 * 1024 * 1024
    )
      throw new Error("Insufficient free disk space.");
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      const metadata = await probe(temp);
      const kind = ["png", "jpg", "jpeg", "webp"].includes(extension)
        ? "image"
        : metadata.hasVideo
          ? "video"
          : "audio";
      if (
        (kind === "image" && !metadata.hasVideo) ||
        (kind !== "image" && metadata.durationFrames < 1)
      )
        throw new Error("Media duration or image stream is invalid.");
      const asset: Asset = AssetSchema.parse({
        id: assetId,
        name: name.slice(0, 120),
        kind,
        extension,
        hash: sha256Hex(bytes),
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
        durationFrames: kind === "image" ? 0 : metadata.durationFrames,
      });
      const stored = await (
        await this.#objects(id)
      ).put(
        (async function* () {
          yield bytes;
        })(),
      );
      if (stored.sha256 !== asset.hash || stored.byteLength !== asset.bytes)
        throw new Error("Asset integrity check failed.");
      // The object is published before the reference; the append commutes with
      // concurrent edits, so it applies to whichever head is current.
      const project = this.#commit({
        operation: "asset.import",
        projectId: id,
        expectedRevision: null,
        next: (current, revision) => {
          const head = current();
          if (head.assets.length >= RESOURCE_POLICY.enforced.assetsPerProject)
            throw new Error("Asset limit reached.");
          return {
            ...head,
            revision,
            assets: [...head.assets, asset],
          };
        },
      });
      return { project, asset };
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async assetFile(id: string, assetId: string) {
    const p = await this.load(id);
    const a = p.assets.find((a) => a.id === Id.parse(assetId));
    if (!a) throw new Error("Asset not found.");
    const file = await this.#verifiedAsset(id, a);
    return { file, asset: a };
  }
  // Committed events in order, for progress/resume by cursor.
  events(afterEventId = 0, limit = 100) {
    return this.#database
      .prepare(
        "SELECT event_id AS eventId, project_id AS projectId, revision, operation FROM outbox WHERE event_id > ? ORDER BY event_id LIMIT ?",
      )
      .all(afterEventId, Math.min(Math.max(1, limit), 1000)) as {
      eventId: number;
      projectId: string;
      revision: number;
      operation: string;
    }[];
  }
}
