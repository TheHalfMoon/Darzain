import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, basename, isAbsolute } from "node:path";
import test, { after } from "node:test";
import {
  LocalContentAddressedStorage,
  StorageError,
} from "../core/donors/skelet/storage.ts";

// Tests remove their own folders; these catch what a failed test leaves.
const bases = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skelet-storage-"));
  bases.push(root);
  const storage = new LocalContentAddressedStorage({
    rootDir: root,
    maxBytes: 4 * 1024 * 1024,
    maxTimeoutMs: 5000,
  });
  return { root, storage, close: () => removeFixture(root, "skelet-storage-") };
}
async function* stream(...buffers) {
  for (const data of buffers) yield Buffer.from(data);
}
async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("streams bytes to deterministic SHA-256 key and verifies before reading", async () => {
  const { root, storage, close } = await fixture();
  try {
    const bytes = Buffer.from("Skelet qualified fixture: one");
    const object = await storage.put(
      stream(bytes.subarray(0, 12), bytes.subarray(12)),
    );
    assert.equal(object.sha256, digest(bytes));
    assert.equal(
      object.storageKey,
      `sha256/${object.sha256.slice(0, 2)}/${object.sha256}`,
    );
    assert.equal(object.byteLength, bytes.length);
    assert.equal(object.created, true);
    assert.equal(await storage.verify(object.sha256), bytes.length);
    assert.deepEqual(await collect(storage.readVerified(object.sha256)), bytes);
    assert.deepEqual(
      await readFile(join(root, ...object.storageKey.split("/"))),
      bytes,
    );
  } finally {
    await close();
  }
});

test("six concurrent equal-content uploads cannot clobber the canonical object", async () => {
  const { storage, close } = await fixture();
  try {
    const payload = Buffer.from("the same fixture");
    const values = await Promise.all(
      Array.from({ length: 6 }, () => storage.put(stream(payload))),
    );
    assert.deepEqual(new Set(values.map((x) => x.sha256)).size, 1);
    assert.equal(values.filter((x) => x.created).length, 1);
    assert.equal(values.filter((x) => !x.created).length, 5);
    assert.deepEqual(
      await collect(storage.readVerified(values[0].sha256)),
      payload,
    );
  } finally {
    await close();
  }
});

test("same byte hash is idempotent and different bytes never replace it", async () => {
  const { storage, close } = await fixture();
  try {
    const first = await storage.put(stream("one"));
    const duplicate = await storage.put(stream("one"));
    const second = await storage.put(stream("two"));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.sha256, first.sha256);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(
      (await collect(storage.readVerified(first.sha256))).toString(),
      "one",
    );
    assert.equal(
      (await collect(storage.readVerified(second.sha256))).toString(),
      "two",
    );
  } finally {
    await close();
  }
});

test("tampered existing object is not served or silently replaced", async () => {
  const { root, storage, close } = await fixture();
  try {
    const stored = await storage.put(stream("approved"));
    await writeFile(join(root, ...stored.storageKey.split("/")), "tampered");
    await assert.rejects(
      () => storage.verify(stored.sha256),
      (error) =>
        error instanceof StorageError && error.code === "CORRUPT_OBJECT",
    );
    await assert.rejects(
      () => collect(storage.readVerified(stored.sha256)),
      (error) =>
        error instanceof StorageError && error.code === "CORRUPT_OBJECT",
    );
    await assert.rejects(
      () => storage.put(stream("approved")),
      (error) =>
        error instanceof StorageError && error.code === "CORRUPT_OBJECT",
    );
  } finally {
    await close();
  }
});

test("rejects invalid hashes, path traversal and unbounded uploads", async () => {
  const { root, storage, close } = await fixture();
  try {
    for (const value of [
      "../etc/passwd",
      "A".repeat(64),
      "C:\\escape",
      "https://foo",
      "a".repeat(63),
    ]) {
      await assert.rejects(
        () => storage.verify(value),
        (error) =>
          error instanceof StorageError && error.code === "INVALID_HASH",
      );
    }
    await assert.rejects(
      () => storage.put(stream(Buffer.alloc(64)), { maxBytes: 16 }),
      (error) => error instanceof StorageError && error.code === "SIZE_LIMIT",
    );
    await assert.rejects(
      () => storage.put(stream("large"), { maxBytes: 9 * 1024 * 1024 }),
      (error) =>
        error instanceof StorageError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
  } finally {
    await close();
  }
});

test("pre-aborted and slow source streams are rejected without temp leaks", async () => {
  const { root, storage, close } = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => storage.put(stream("discard"), { signal: controller.signal }),
      (error) => error instanceof StorageError && error.code === "ABORTED",
    );
    async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 250));
      yield Buffer.from("late");
    }
    await assert.rejects(
      () => storage.put(slow(), { timeoutMs: 30 }),
      (error) => error instanceof StorageError && error.code === "TIME_LIMIT",
    );
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
  } finally {
    await close();
  }
});

test("garbage collection touches only older UUID-named temporary files", async () => {
  const { root, storage, close } = await fixture();
  try {
    await storage.put(stream("create directories"));
    const temp = join(root, ".tmp");
    const old = join(temp, randomUUID() + ".part");
    const unrelated = join(temp, "do-not-delete.txt");
    await writeFile(old, "orphan");
    await utimes(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
    await writeFile(unrelated, "keep");
    assert.equal(await storage.pruneTemporary(6001), 1);
    assert.deepEqual(await readdir(temp), ["do-not-delete.txt"]);
  } finally {
    await close();
  }
});

test("storage root and hash directories reject symlink escape where supported", async (t) => {
  const { root, storage, close } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "skelet-outside-"));
  bases.push(outside);
  try {
    await mkdir(root, { recursive: true });
    try {
      await symlink(outside, join(root, "sha256"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip("Filesystem does not permit this symlink fixture");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => storage.put(stream("blocked")),
      (error) => error instanceof StorageError && error.code === "UNSAFE_PATH",
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await close();
    await removeFixture(outside, "skelet-outside-");
  }
});

test("rejects pruning live uploads and closes source iterator after size failure", async () => {
  const { root, storage, close } = await fixture();
  let didReturn = false;
  try {
    const src = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { value: Buffer.alloc(50), done: false };
          },
          async return() {
            didReturn = true;
            return { done: true };
          },
        };
      },
    };
    await assert.rejects(
      () => storage.put(src, { maxBytes: 75 }),
      (error) => error instanceof StorageError && error.code === "SIZE_LIMIT",
    );
    assert.equal(didReturn, true);
    await assert.rejects(
      () => storage.pruneTemporary(1000),
      (error) =>
        error instanceof StorageError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
  } finally {
    await close();
  }
});

test("empty content and invalid stream chunks behave deterministically", async () => {
  const { root, storage, close } = await fixture();
  try {
    const empty = await storage.put(stream());
    assert.equal(empty.sha256, digest(Buffer.alloc(0)));
    assert.equal(empty.byteLength, 0);
    assert.deepEqual(
      await collect(storage.readVerified(empty.sha256)),
      Buffer.alloc(0),
    );
    async function* bad() {
      yield "not bytes";
    }
    await assert.rejects(
      () => storage.put(bad()),
      (error) =>
        error instanceof StorageError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
  } finally {
    await close();
  }
});

test(
  "POSIX refuses a storage root readable by other accounts",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const { root, storage, close } = await fixture();
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(root, 0o755);
      await assert.rejects(
        () => storage.put(stream("unsafe")),
        (error) =>
          error instanceof StorageError && error.code === "UNSAFE_PATH",
      );
      await chmod(root, 0o700);
    } finally {
      await close();
    }
  },
);

async function removeFixture(target, prefix) {
  const base = resolve(tmpdir()),
    absolute = resolve(target),
    rel = relative(base, absolute);
  assert.ok(
    rel &&
      !rel.startsWith("..") &&
      !isAbsolute(rel) &&
      basename(absolute).startsWith(prefix),
  );
  await rm(absolute, { recursive: true, force: true });
}
