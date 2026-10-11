import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link, lstat, mkdir, open, readdir, realpath, rm,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const HASH = /^[0-9a-f]{64}$/;
const TEMP = /^[0-9a-f-]{36}\.part$/;
const CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type StorageErrorCode =
  | "INVALID_HASH" | "INVALID_INPUT" | "SIZE_LIMIT"
  | "TIME_LIMIT" | "ABORTED" | "UNSAFE_PATH"
  | "CORRUPT_OBJECT" | "STORAGE_IO";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StorageError";
  }
}

export interface StoredObject {
  /** Lowercase SHA-256 of actual uploaded bytes. */
  sha256: string;
  /** Internal relative key, never an unguarded public download URL. */
  storageKey: string;
  byteLength: number;
  /** False if identical verified bytes already exist. */
  created: boolean;
}
export interface PutOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface StorageProvider {
  put(source: AsyncIterable<Uint8Array>, options?: PutOptions): Promise<StoredObject>;
  readVerified(sha256: string): AsyncIterable<Uint8Array>;
  verify(sha256: string): Promise<number>;
}
export interface LocalStorageOptions {
  /** Operator-owned, private local filesystem directory; do not mount as public webroot. */
  rootDir: string;
  maxBytes?: number;
  maxTimeoutMs?: number;
}

function assertHash(value: string): void {
  if (!HASH.test(value)) {
    throw new StorageError("INVALID_HASH", "Expected lowercase SHA-256");
  }
}
function budget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StorageError("INVALID_INPUT", name + " must be a positive integer");
  }
  return value;
}
function throwAborted(signal: AbortSignal, isTimedOut: boolean): never {
  throw new StorageError(
    isTimedOut ? "TIME_LIMIT" : "ABORTED",
    isTimedOut ? "Storage operation timed out" : "Storage operation aborted",
  );
}
async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
  isTimedOut: () => boolean,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throwAborted(signal, isTimedOut());
  let onAbort: (() => void) | undefined;
  const rejected = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new StorageError(
      isTimedOut() ? "TIME_LIMIT" : "ABORTED", "Storage upload interrupted",
    ));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), rejected]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
/** POSIX: durable directory entry publication after atomic hardlink promotion. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function mustBeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new StorageError("UNSAFE_PATH", "Storage directory must be private and trusted");
  }
}
async function mustBeFile(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 2) {
    throw new StorageError("UNSAFE_PATH", "Stored object is not a trusted regular file");
  }
  return info.size;
}
function internalKey(hash: string): string {
  return "sha256/" + hash.slice(0, 2) + "/" + hash;
}

/**
 * Unpublished byte store. Caller MUST independently qualify metadata,
 * redistribution rights, workspace authorization, and database publication.
 * Never expose the raw storage directory through a web server.
 */
export class LocalContentAddressedStorage implements StorageProvider {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly maxTimeoutMs: number;

  constructor(options: LocalStorageOptions) {
    if (!options.rootDir?.trim()) {
      throw new StorageError("INVALID_INPUT", "Storage root directory is required");
    }
    this.rootDir = resolve(options.rootDir);
    this.maxBytes = budget(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.maxTimeoutMs = budget(options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS, "maxTimeoutMs");
  }

  private async root(): Promise<string> {
    await mustBeDirectory(this.rootDir);
    return realpath(this.rootDir);
  }
  private async directory(hash: string): Promise<string> {
    assertHash(hash);
    const root = await this.root();
    const top = join(root, "sha256");
    await mustBeDirectory(top);
    const dir = join(top, hash.slice(0, 2));
    await mustBeDirectory(dir);
    return dir;
  }
  private async tempDirectory(): Promise<string> {
    const root = await this.root();
    const tempDir = join(root, ".tmp");
    await mustBeDirectory(tempDir);
    return tempDir;
  }
  private async target(hash: string): Promise<string> {
    return join(await this.directory(hash), hash);
  }
  private async openVerified(hash: string): Promise<{ handle: FileHandle; bytes: number }> {
    const path = await this.target(hash);
    const size = await mustBeFile(path);
    if (size > this.maxBytes) {
      throw new StorageError("SIZE_LIMIT", "Existing object exceeds storage budget");
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== size) {
        throw new StorageError("UNSAFE_PATH", "Object changed during verification");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > this.maxBytes) {
          throw new StorageError("SIZE_LIMIT", "Object exceeded maximum size");
        }
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (position !== stat.size || digest.digest("hex") !== hash) {
        throw new StorageError("CORRUPT_OBJECT", "Stored bytes do not match expected SHA-256");
      }
      return { handle, bytes: position };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async verify(sha256: string): Promise<number> {
    assertHash(sha256);
    const { handle, bytes } = await this.openVerified(sha256);
    await handle.close();
    return bytes;
  }

  async *readVerified(sha256: string): AsyncIterable<Uint8Array> {
    assertHash(sha256);
    const { handle, bytes } = await this.openVerified(sha256);
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      let position = 0;
      while (position < bytes) {
        const { bytesRead } = await handle.read(
          buffer, 0, Math.min(buffer.length, bytes - position), position,
        );
        if (bytesRead === 0) {
          throw new StorageError("CORRUPT_OBJECT", "Object shortened during reading");
        }
        position += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  async put(source: AsyncIterable<Uint8Array>, options: PutOptions = {}): Promise<StoredObject> {
    const allowedBytes = budget(options.maxBytes ?? this.maxBytes, "maxBytes");
    const allowedTime = budget(options.timeoutMs ?? this.maxTimeoutMs, "timeoutMs");
    if (allowedBytes > this.maxBytes || allowedTime > this.maxTimeoutMs) {
      throw new StorageError("INVALID_INPUT", "Operation cannot exceed configured budget");
    }
    const timeoutSignal = AbortSignal.timeout(allowedTime);
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const tempDir = await this.tempDirectory();
    const temporary = join(tempDir, randomUUID() + ".part");
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      const iterator = source[Symbol.asyncIterator]();
      let iteratorCompleted = false;
      try {
        for (;;) {
          const next = await nextWithAbort(iterator, signal, () => timeoutSignal.aborted);
          if (next.done) { iteratorCompleted = true; break; }
          if (!(next.value instanceof Uint8Array)) {
            throw new StorageError("INVALID_INPUT", "Input must yield Uint8Array chunks");
          }
          // Own a stable snapshot: callers may reuse/mutate their input buffers.
          const bytesToWrite = Buffer.from(next.value);
          bytes += bytesToWrite.byteLength;
          if (bytes > allowedBytes) {
            throw new StorageError("SIZE_LIMIT", "Upload exceeds maximum bytes");
          }
          hash.update(bytesToWrite);
          let offset = 0;
          while (offset < bytesToWrite.byteLength) {
            if (signal.aborted) throwAborted(signal, timeoutSignal.aborted);
            const result = await file.write(
              bytesToWrite, offset, bytesToWrite.byteLength - offset,
            );
            if (result.bytesWritten <= 0) {
              throw new StorageError("STORAGE_IO", "Zero-length write");
            }
            offset += result.bytesWritten;
          }
        }
      } finally {
        if (!iteratorCompleted && iterator.return) {
          // Cancel on ANY failure, including size and I/O errors. Never let an
          // uncooperative source's return() hang error handling or cleanup.
          try { void Promise.resolve(iterator.return()).catch(() => {}); }
          catch { /* preserve original upload error */ }
        }
      }
      if (signal.aborted) throwAborted(signal, timeoutSignal.aborted);
      await file.sync();
      await file.close();
      file = undefined;
      const digest = hash.digest("hex");
      // Re-read the fsynced temporary file through the filesystem cache.
      // This detects code/write mismatches, not physical-media faults.
      const verifyTemp = await open(temporary, "r");
      try {
        const actual = createHash("sha256");
        const readBuffer = Buffer.allocUnsafe(CHUNK_SIZE);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await verifyTemp.read(
            readBuffer, 0, readBuffer.length, offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > allowedBytes) {
            throw new StorageError("SIZE_LIMIT", "Temporary file exceeded byte budget");
          }
          actual.update(readBuffer.subarray(0, bytesRead));
        }
        if (offset !== bytes || actual.digest("hex") !== digest) {
          throw new StorageError("CORRUPT_OBJECT", "Temporary bytes disagree with SHA-256");
        }
      } finally { await verifyTemp.close(); }
      const target = await this.target(digest);
      let created = false;
      try {
        // Same-volume hardlink is atomic and NEVER overwrites existing hashes.
        await link(temporary, target);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingSize = await this.verify(digest);
        if (existingSize !== bytes) {
          throw new StorageError("CORRUPT_OBJECT", "Existing object size conflicts with upload");
        }
      }
      // Both creators and followers must wait for durable directory entries.
      // A follower can otherwise return before the creator's first fsync.
      const root = await this.root();
      await syncDirectory(await this.directory(digest));
      await syncDirectory(join(root, "sha256"));
      await syncDirectory(root);
      return { sha256: digest, storageKey: internalKey(digest), byteLength: bytes, created };
    } finally {
      if (file) await file.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** Only removes old UUID-named temporary files; never touches published objects. */
  async pruneTemporary(olderThanMs: number): Promise<number> {
    budget(olderThanMs, "olderThanMs");
    if (olderThanMs <= this.maxTimeoutMs + 1000) {
      throw new StorageError("INVALID_INPUT", "Prune age must exceed upload timeout");
    }
    const dir = await this.tempDirectory();
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const name of await readdir(dir)) {
      if (!TEMP.test(name)) continue;
      const path = join(dir, name);
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (info.mtimeMs <= cutoff) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
