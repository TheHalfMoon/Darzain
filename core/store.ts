import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  unlink,
  statfs,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "./donors/ninerr/canonical.ts";
import { ProjectSchema, Id, AssetSchema, createProject } from "./project.ts";
import type { Project, Asset } from "./project.ts";
import { safePath, initializeRoot } from "./paths.ts";
import { mediaHeader, MAX_ASSET_BYTES, probe } from "./media.ts";
export class ProjectStore {
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
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, body, { flag: "wx" });
    try {
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async create(name: string) {
    const p = createProject(name);
    const dir = await this.directory(p.id);
    await mkdir(dir, { recursive: false });
    for (const sub of ["snapshots", "assets", "exports", "imports"])
      await mkdir(await this.file(p.id, sub));
    await this.persist(p);
    return p;
  }
  private async persist(p: Project) {
    const data = canonicalJson(ProjectSchema.parse(p));
    await this.atomic(
      await this.file(p.id, "snapshots", `${p.revision}.json`),
      data,
    );
    const head = { revision: p.revision, hash: sha256Hex(data) };
    await this.atomic(await this.file(p.id, "head.json"), canonicalJson(head));
  }
  async load(id: string): Promise<Project> {
    // A corrupt committed head is reported. Recovery is explicit and never rewrites evidence.
    const head = JSON.parse(
      await readFile(await this.file(id, "head.json"), "utf8"),
    );
    if (
      !Number.isSafeInteger(head.revision) ||
      head.revision < 0 ||
      typeof head.hash !== "string"
    )
      throw new Error("Corrupt project head.");
    const data = await readFile(
      await this.file(id, "snapshots", `${head.revision}.json`),
      "utf8",
    );
    if (sha256Hex(data) !== head.hash)
      throw new Error("Project snapshot hash mismatch.");
    const p = ProjectSchema.parse(JSON.parse(data));
    if (p.id !== id || p.revision !== head.revision)
      throw new Error("Project snapshot identity mismatch.");
    return p;
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
      next.revision = current.revision + 1;
      if (next.revision > 10000)
        throw new Error("Project history limit reached.");
      await this.persist(next);
      return next;
    });
  }
  async importAsset(id: string, name: string, bytes: Buffer) {
    return this.exclusive(id, async () => {
      const p = await this.load(id);
      if (p.assets.length >= 200) throw new Error("Asset limit reached.");
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
        const target = await this.file(
          id,
          "assets",
          `${asset.hash}.${asset.extension}`,
        );
        try {
          await writeFile(target, bytes, { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          const stored = await readFile(target);
          if (sha256Hex(stored) !== asset.hash)
            throw new Error("Existing asset hash mismatch.");
        }
        p.assets.push(asset);
        p.revision++;
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
    const file = await this.file(id, "assets", `${a.hash}.${a.extension}`);
    const bytes = await readFile(file);
    if (sha256Hex(bytes) !== a.hash || bytes.length !== a.bytes)
      throw new Error("Asset integrity check failed.");
    return { file, asset: a };
  }
}
