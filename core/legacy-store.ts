import {
  mkdir,
  writeFile,
  readdir,
  unlink,
  statfs,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "./donors/ninerr/canonical.ts";
import { ProjectSchema, Id, AssetSchema, createProject } from "./project.ts";
import type { Project, Asset } from "./project.ts";
import { safePath, initializeRoot } from "./paths.ts";
import { mediaHeader, MAX_ASSET_BYTES, probe } from "./media.ts";
import {
  publishFile,
  readBounded,
  syncDirectory,
  fingerprintFile,
  preserveFile,
} from "./durable.ts";
import { LocalContentAddressedStorage } from "./donors/skelet/storage.ts";
import { z } from "zod";
import { RESOURCE_POLICY } from "./command/policy.ts";
const HeadSchema = z
  .object({
    revision: z.number().int().min(0).max(10000),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
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
export class LegacyProjectStore {
  readonly root: string;
  private chains = new Map<string, Promise<unknown>>();
  constructor(root: string) {
    this.root = root;
  }
  async initialize() {
    await initializeRoot(this.root);
    await mkdir(await safePath(this.root, "projects"), { recursive: true });
  }
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) || Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.chains.set(id, task);
    try {
      return await task;
    } finally {
      if (this.chains.get(id) === task) this.chains.delete(id);
    }
  }
  async directory(id: string) {
    Id.parse(id);
    return safePath(this.root, "projects", id);
  }
  async file(id: string, ...parts: string[]) {
    return safePath(this.root, "projects", Id.parse(id), ...parts);
  }
  async atomic(file: string, body: string | Buffer) {
    await publishFile(file, body);
  }
  async create(name: string) {
    const p = createProject(name);
    const dir = await this.directory(p.id);
    await mkdir(dir, { recursive: false });
    for (const sub of ["snapshots", "assets", "exports", "imports"])
      await mkdir(await this.file(p.id, sub));
    await syncDirectory(dir);
    await syncDirectory(await safePath(this.root, "projects"));
    await syncDirectory(this.root);
    await this.persist(p);
    return p;
  }
  private async persist(p: Project) {
    const data = canonicalJson(ProjectSchema.parse(p));
    await publishFile(
      await this.file(p.id, "snapshots", `${p.revision}.json`),
      data,
      false,
    );
    const head = { revision: p.revision, hash: sha256Hex(data) };
    await publishFile(
      await this.file(p.id, "snapshots", `${p.revision}.receipt.json`),
      canonicalJson(head),
      false,
    );
    await this.atomic(await this.file(p.id, "head.json"), canonicalJson(head));
  }
  async load(id: string): Promise<Project> {
    // A corrupt committed head is reported. Recovery is explicit and never rewrites evidence.
    const head = HeadSchema.parse(
      JSON.parse(
        (await readBounded(await this.file(id, "head.json"))).toString("utf8"),
      ),
    );
    const data = (
      await readBounded(
        await this.file(id, "snapshots", `${head.revision}.json`),
      )
    ).toString("utf8");
    if (sha256Hex(data) !== head.hash)
      throw new Error("Project snapshot hash mismatch.");
    const p = ProjectSchema.parse(JSON.parse(data));
    if (p.id !== id || p.revision !== head.revision)
      throw new Error("Project snapshot identity mismatch.");
    return p;
  }
  private async revisions(id: string) {
    return (await readdir(await this.file(id, "snapshots")))
      .filter((file) => /^(0|[1-9][0-9]{0,4})\.json$/.test(file))
      .map((file) => Number(file.slice(0, -5)))
      .filter((n) => n <= 10000)
      .sort((a, b) => b - a);
  }
  private async headFingerprint(id: string): Promise<string | null> {
    try {
      return await fingerprintFile(await this.file(id, "head.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  // Read-only access to one verified revision, for migration (T3).
  readRevision(id: string, revision: number) {
    return this.snapshot(id, revision);
  }
  private async snapshot(id: string, revision: number) {
    HeadSchema.shape.revision.parse(revision);
    const receipt = HeadSchema.parse(
      JSON.parse(
        (
          await readBounded(
            await this.file(id, "snapshots", `${revision}.receipt.json`),
          )
        ).toString("utf8"),
      ),
    );
    const data = (
      await readBounded(await this.file(id, "snapshots", `${revision}.json`))
    ).toString("utf8");
    if (receipt.revision !== revision || sha256Hex(data) !== receipt.hash)
      throw new Error("Project snapshot hash mismatch.");
    const project = ProjectSchema.parse(JSON.parse(data));
    if (project.id !== id || project.revision !== revision)
      throw new Error("Project snapshot identity mismatch.");
    return project;
  }
  async history(id: string): Promise<ProjectHistory> {
    return this.exclusive(id, async () => {
      const headFingerprint = await this.headFingerprint(id);
      let current: Project | null = null;
      try {
        current = await this.load(id);
      } catch {
        /* Expose verified candidates despite a damaged head. */
      }
      const snapshots: ProjectHistory["snapshots"] = [];
      for (const revision of await this.revisions(id)) {
        try {
          // A legacy current head is an integrity anchor; unreceipted older files are not.
          const project =
            current?.revision === revision
              ? current
              : await this.snapshot(id, revision);
          snapshots.push({
            revision,
            name: project.name,
            verified: true,
            error: null,
          });
        } catch {
          snapshots.push({
            revision,
            name: null,
            verified: false,
            error: "Snapshot cannot be verified.",
          });
        }
      }
      return {
        projectId: id,
        headFingerprint,
        currentRevision: current?.revision ?? null,
        snapshots,
      };
    });
  }
  private async retainLegacyAnchor(current: Project) {
    const file = await this.file(
      current.id,
      "snapshots",
      `${current.revision}.receipt.json`,
    );
    try {
      await access(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const data = (
        await readBounded(
          await this.file(current.id, "snapshots", `${current.revision}.json`),
        )
      ).toString("utf8");
      const head = HeadSchema.parse(
        JSON.parse(
          (
            await readBounded(await this.file(current.id, "head.json"))
          ).toString("utf8"),
        ),
      );
      if (head.revision !== current.revision || sha256Hex(data) !== head.hash)
        throw new Error("Legacy snapshot integrity check failed.");
      await publishFile(
        file,
        canonicalJson({ revision: current.revision, hash: sha256Hex(data) }),
        false,
      );
    }
  }
  private async nextRevision(id: string) {
    const next = Math.max(-1, ...(await this.revisions(id))) + 1;
    if (next > 10000) throw new Error("Project history limit reached.");
    return next;
  }
  async restore(
    id: string,
    revision: number,
    expectedHeadFingerprint: string | null,
  ) {
    return this.exclusive(id, async () => {
      const fingerprint = await this.headFingerprint(id);
      if (fingerprint !== expectedHeadFingerprint)
        throw new Error("Revision conflict; refresh history before restoring.");
      let current: Project | null = null;
      try {
        current = await this.load(id);
      } catch {
        /* Recovery can replace a damaged head. */
      }
      if (current) await this.retainLegacyAnchor(current);
      const selected =
        current?.revision === revision
          ? current
          : await this.snapshot(id, revision);
      for (const asset of selected.assets) await this.verifiedAsset(id, asset);
      const next = ProjectSchema.parse({
        ...selected,
        revision: await this.nextRevision(id),
      });
      const recoveryId = randomUUID();
      await mkdir(await this.file(id, "recovery"), { recursive: true });
      await syncDirectory(await this.directory(id));
      if (fingerprint)
        await preserveFile(
          await this.file(id, "head.json"),
          await this.file(id, "recovery", `${recoveryId}.head.bin`),
          fingerprint,
        );
      // A receipt records intent before publication. A committed snapshot identifies success.
      await publishFile(
        await this.file(id, "recovery", `${recoveryId}.json`),
        canonicalJson({
          fromRevision: revision,
          toRevision: next.revision,
          previousHeadFingerprint: expectedHeadFingerprint,
        }),
        false,
      );
      await this.persist(next);
      return next;
    });
  }
  private async objects(id: string) {
    const rootDir = await this.file(id, "objects");
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await syncDirectory(await this.directory(id));
    return new LocalContentAddressedStorage({
      rootDir,
      maxBytes: MAX_ASSET_BYTES,
    });
  }
  private async verifiedAsset(id: string, asset: Asset) {
    const objectFile = await this.file(
      id,
      "objects",
      "sha256",
      asset.hash.slice(0, 2),
      asset.hash,
    );
    try {
      if ((await (await this.objects(id)).verify(asset.hash)) !== asset.bytes)
        throw new Error("Asset integrity check failed.");
      return objectFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  async list() {
    const ids = await readdir(await safePath(this.root, "projects"));
    return Promise.all(
      ids
        .filter((x) => Id.safeParse(x).success)
        .map(async (id) => {
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
  }
  async save(input: Project, expectedRevision: number) {
    return this.exclusive(input.id, async () => {
      const next = ProjectSchema.parse(input);
      const current = await this.load(next.id);
      if (
        current.revision !== expectedRevision ||
        next.revision !== expectedRevision
      )
        throw new Error("Revision conflict; reopen before saving.");
      // Asset identities and immutable metadata come only from the validated import path.
      if (canonicalJson(next.assets) !== canonicalJson(current.assets))
        throw new Error("Assets must be added through asset.import.");
      await this.retainLegacyAnchor(current);
      next.revision = await this.nextRevision(next.id);
      await this.persist(next);
      return next;
    });
  }
  async importAsset(id: string, name: string, bytes: Buffer) {
    return this.exclusive(id, async () => {
      const p = await this.load(id);
      if (p.assets.length >= RESOURCE_POLICY.enforced.assetsPerProject)
        throw new Error("Asset limit reached.");
      if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES)
        throw new Error("Asset size exceeds limit.");
      const extension = name.split(".").pop()?.toLowerCase() || "";
      mediaHeader(bytes, extension);
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
        const objects = await this.objects(id);
        const stored = await objects.put(
          (async function* () {
            yield bytes;
          })(),
        );
        if (stored.sha256 !== asset.hash || stored.byteLength !== asset.bytes)
          throw new Error("Asset integrity check failed.");
        await this.retainLegacyAnchor(p);
        p.assets.push(asset);
        p.revision = await this.nextRevision(id);
        await this.persist(p);
        return { project: p, asset };
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
  }
  async assetFile(id: string, assetId: string) {
    const p = await this.load(id);
    const a = p.assets.find((a) => a.id === Id.parse(assetId));
    if (!a) throw new Error("Asset not found.");
    const file = await this.verifiedAsset(id, a);
    return { file, asset: a };
  }
}
