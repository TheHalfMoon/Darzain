import { open, link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export async function fingerprintFile(file: string) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Project head is not a regular file.");
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(64 * 1024),
      deadline = Date.now() + 10000;
    let offset = 0;
    while (offset < stat.size) {
      if (Date.now() > deadline)
        throw new Error("Project head fingerprint time limit exceeded.");
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (!result.bytesRead)
        throw new Error("Project head changed during reading.");
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== stat.size)
      throw new Error("Project head changed during reading.");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function preserveFile(
  source: string,
  target: string,
  expectedHash: string,
) {
  // A hardlink retains original bytes when atomic head publication replaces its name.
  const handle = await open(source, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await link(source, target);
  await syncDirectory(path.dirname(target));
  if ((await fingerprintFile(target)) !== expectedHash)
    throw new Error("Project head changed during preservation.");
}

export async function readBounded(file: string, maxBytes = 2 * 1024 * 1024) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Project file exceeds its byte limit.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead)
        throw new Error("Project file changed during reading.");
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== stat.size)
      throw new Error("Project file changed during reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string) {
  // Node cannot fsync directories on Windows. File fsync still precedes publication.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishFile(
  file: string,
  body: string | Buffer,
  replace = true,
) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) await rename(temporary, file);
    else await link(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
