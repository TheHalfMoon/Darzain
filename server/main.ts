import { createServer } from "node:http";
import { readFile, writeFile, open } from "node:fs/promises";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { CreativeAPI } from "./api.ts";
import { safePath } from "../core/paths.ts";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const root = path.resolve(
  process.env.DARZAIN_WORKSPACE || path.join(projectRoot, ".darzain"),
);
const store = new ProjectStore(root);
await store.initialize();
const lock = await open(await safePath(root, "server.lock"), "wx").catch(() => {
  throw new Error(
    "Workspace server is already running or a previous server left a lock. Verify no server is running before removing server.lock.",
  );
});
const token = randomBytes(32).toString("hex");
await writeFile(await safePath(root, "token"), token, { mode: 0o600 });
const api = new CreativeAPI(store);
const port = Number(process.env.DARZAIN_PORT || 4318);
const origin = `http://127.0.0.1:${port}`;
function sameToken(value: string) {
  const a = Buffer.from(value),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req: import("node:http").IncomingMessage, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request size limit exceeded.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
let closing = false;
const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const media = (bytes: Buffer, type: string, attachment = false) => {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", type);
    if (attachment)
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="darzain.mp4"',
      );
    const range = req.headers.range;
    if (!range) {
      res.setHeader("Content-Length", bytes.length);
      res.writeHead(200);
      res.end(bytes);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = match && !match[1] ? Number(match[2]) : null;
    const start =
        suffix !== null
          ? Math.max(0, bytes.length - suffix)
          : Number(match?.[1]),
      end =
        suffix !== null
          ? bytes.length - 1
          : match?.[2]
            ? Number(match[2])
            : bytes.length - 1;
    if (
      !match ||
      (!match[1] && !match[2]) ||
      (suffix !== null && (!Number.isSafeInteger(suffix) || suffix <= 0)) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= bytes.length ||
      end < start
    ) {
      res.writeHead(416, {
        "Content-Range": `bytes */${bytes.length}`,
        "Content-Length": 0,
      });
      res.end();
      return;
    }
    const last = Math.min(end, bytes.length - 1),
      chunk = bytes.subarray(start, last + 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${last}/${bytes.length}`,
      "Content-Length": chunk.length,
    });
    res.end(chunk);
  };
  try {
    if (closing)
      return json(503, { error: "Server is shutting down.", requestId });
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(403, { error: "Origin is not allowed.", requestId });
    const url = new URL(req.url || "/", origin);
    if (url.pathname.startsWith("/api/")) {
      const credential =
        req.headers.authorization?.replace(/^Bearer /, "") ||
        /(?:^|; )darzain=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1] ||
        "";
      if (!sameToken(credential))
        return json(401, { error: "Authentication required.", requestId });
      if (req.method === "GET" && url.pathname === "/api/v1/tools")
        return json(200, api.catalog());
      if (req.method === "POST" && url.pathname === "/api/v1/call") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(415, { error: "JSON content type required.", requestId });
        const payload = JSON.parse(
          (await body(req, 2 * 1024 * 1024)).toString(),
        );
        if (
          Object.keys(payload).some((k) => !["name", "arguments"].includes(k))
        )
          throw new Error("Unsupported call property.");
        const result = await api.call(payload.name, payload.arguments);
        return json(200, { apiVersion: 1, requestId, result });
      }
      const upload = /^\/api\/v1\/projects\/([^/]+)\/assets$/.exec(
        url.pathname,
      );
      if (req.method === "POST" && upload) {
        const name = decodeURIComponent(
          String(req.headers["x-asset-name"] || ""),
        );
        return json(
          200,
          await store.importAsset(
            upload[1],
            name,
            await body(req, 50 * 1024 * 1024),
          ),
        );
      }
      const asset = /^\/api\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && asset) {
        const { file, asset: a } = await store.assetFile(asset[1], asset[2]);
        const bytes = await readFile(file);
        const mime: Record<string, string> = {
          image: `image/${a.extension === "jpg" ? "jpeg" : a.extension}`,
          video: a.extension === "webm" ? "video/webm" : "video/mp4",
          audio:
            a.extension === "mp3"
              ? "audio/mpeg"
              : a.extension === "wav"
                ? "audio/wav"
                : "audio/ogg",
        };
        media(bytes, mime[a.kind]);
        return;
      }
      const exportMatch = /^\/api\/v1\/jobs\/([^/]+)\/artifact$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && exportMatch) {
        const job = api.queue.status(exportMatch[1]);
        if (job.state !== "COMPLETED" || !job.artifact)
          throw new Error("Artifact is not complete.");
        const file = await store.file(
          job.projectId,
          ...job.artifact.split("/"),
        );
        media(await readFile(file), "video/mp4", true);
        return;
      }
      return json(404, { error: "Endpoint not found.", requestId });
    }
    if (req.method !== "GET")
      return json(405, { error: "Method not allowed.", requestId });
    // Local navigation grants a session cookie; cross-site requests were rejected above.
    res.setHeader(
      "Set-Cookie",
      `darzain=${token}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    const relative =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname).slice(1);
    const file = await safePath(path.join(projectRoot, "dist"), relative);
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    const bytes = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
    });
    res.end(bytes);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Operation failed.";
    const message = reason.includes("Revision conflict")
      ? reason
      : reason
          .replaceAll(root, "[workspace]")
          .replaceAll(projectRoot, "[application]");
    json(400, { error: message, requestId });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Darzain is running at ${origin}; workspace ${root}`),
);
const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  const drained = api.queue.close();
  const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
  await drained;
  await stopped;
  await lock.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(await safePath(root, "server.lock")).catch(() => {});
  process.exit(code);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
server.once("error", (error) => {
  console.error(error.message);
  void close(1);
});
// Test/service supervisors may shut down their own child through private process IPC.
if (process.send)
  process.on("message", (message) => {
    if (message === "shutdown") void close();
  });
