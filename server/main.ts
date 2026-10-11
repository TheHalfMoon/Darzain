import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "../core/store.ts";
import { CreativeAPI, principals } from "./api.ts";
import { safePath, initializeRoot } from "../core/paths.ts";
import { authorize } from "../core/command/registry.ts";
import type { Principal } from "../core/command/registry.ts";
import { parseEnvelope } from "../core/command/envelope.ts";
import {
  CommandError,
  httpStatus,
  toCommandError,
} from "../core/command/errors.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";
import { acquireServiceLock } from "../core/service-lock.ts";
import { isLegacyWorkspace } from "../core/migrate.ts";
import { closeWorkers } from "../core/process/workers.ts";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const env = (name: string) =>
  process.env[`YAMAKAN_${name}`] || process.env[`DARZAIN_${name}`];
const root = path.resolve(
  env("WORKSPACE") || path.join(projectRoot, ".yamakan"),
);
// A pre-database Darzain workspace is never opened in place: that would write
// into the original root. It is migrated into a new root instead.
const legacyHint = (dir: string) =>
  `npm run migrate -- "${dir}" "<new empty folder>"`;
if (await isLegacyWorkspace(root)) {
  console.error(
    `This workspace uses the pre-Yamakan format and was not opened. Migrate it with: ${legacyHint(root)}`,
  );
  process.exit(1);
}
const legacyDefault = path.join(projectRoot, ".darzain");
if (!env("WORKSPACE") && (await isLegacyWorkspace(legacyDefault)))
  console.warn(
    `A pre-Yamakan workspace was found and left untouched. Migrate it with: ${legacyHint(legacyDefault)}`,
  );
await initializeRoot(root);
// The OS-owned lock is taken before the database is read and is released by
// the operating system if this process dies.
const lock = await acquireServiceLock(root);
const store = new ProjectStore(root);
await store.initialize();
// Separate credentials: the browser session secret exists only in memory and in
// an HttpOnly cookie; explicit local clients (CLI, MCP, SDK) read the bearer file.
const sessionToken = randomBytes(32).toString("hex");
const clientToken = randomBytes(32).toString("hex");
await writeFile(await safePath(root, "token"), clientToken, { mode: 0o600 });
const api = new CreativeAPI(store);
// Durable jobs: reconcile any interrupted attempts and resume queued work.
await api.queue.start();
const port = Number(env("PORT") || 4318);
const origin = `http://127.0.0.1:${port}`;
function sameToken(value: string, expected: string) {
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authenticate(
  req: import("node:http").IncomingMessage,
): Principal | null {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    return bearer && sameToken(bearer, clientToken)
      ? principals["local-client"]
      : null;
  }
  const cookie = /(?:^|; )yamakan=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
  if (!cookie || !sameToken(cookie, sessionToken)) return null;
  // Cookie requests must come from the Yamakan page itself: state changes carry
  // our exact Origin; reads reject other sites, including other loopback ports.
  const site = req.headers["sec-fetch-site"];
  if (req.method !== "GET" && req.headers.origin !== origin) return null;
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return null;
  return principals["browser-ui"];
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
  let requestId: string = randomUUID();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const fail = (error: CommandError) =>
    json(httpStatus[error.code], {
      apiVersion: 1,
      requestId,
      error: {
        code: error.code,
        message: error.message
          .replaceAll(root, "[workspace]")
          .replaceAll(projectRoot, "[application]"),
        retryable: error.retryable,
      },
    });
  // Streams a file (or one byte range of it) without reading it into memory.
  const media = async (file: string, type: string, attachment = false) => {
    const size = (await stat(file)).size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", type);
    if (attachment)
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="yamakan.mp4"',
      );
    const range = req.headers.range;
    let start = 0,
      last = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const suffix = match && !match[1] ? Number(match[2]) : null;
      start = suffix !== null ? Math.max(0, size - suffix) : Number(match?.[1]);
      let end = size - 1;
      if (suffix === null && match?.[2]) end = Number(match[2]);
      if (
        !match ||
        (!match[1] && !match[2]) ||
        (suffix !== null && (!Number.isSafeInteger(suffix) || suffix <= 0)) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start >= size ||
        end < start
      ) {
        res.writeHead(416, {
          "Content-Range": `bytes */${size}`,
          "Content-Length": 0,
        });
        res.end();
        return;
      }
      last = Math.min(end, size - 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${last}/${size}`,
        "Content-Length": last - start + 1,
      });
    } else res.writeHead(200, { "Content-Length": size });
    if (size === 0) return void res.end();
    await pipeline(createReadStream(file, { start, end: last }), res).catch(
      () => res.destroy(),
    );
  };
  try {
    if (closing)
      return fail(new CommandError("UNAVAILABLE", "Server is shutting down."));
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return fail(
        new CommandError("FORBIDDEN_ORIGIN", "Origin is not allowed."),
      );
    const url = new URL(req.url || "/", origin);
    if (url.pathname.startsWith("/api/")) {
      const principal = authenticate(req);
      if (!principal)
        return fail(
          new CommandError("UNAUTHENTICATED", "Authentication required."),
        );
      if (req.method === "GET" && url.pathname === "/api/v1/tools")
        return json(200, api.catalog());
      if (req.method === "POST" && url.pathname === "/api/v1/call") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new CommandError("VALIDATION", "JSON content type required.");
        const request = parseEnvelope(
          JSON.parse(
            (await body(req, RESOURCE_POLICY.enforced.requestBytes)).toString(),
          ),
        );
        requestId = request.requestId;
        const { operation, result } = await api.execute(
          request.operation,
          request.parameters,
          principal,
          request.clientRequestId ? request.requestId : undefined,
        );
        return json(200, { apiVersion: 1, requestId, operation, result });
      }
      const upload = /^\/api\/v1\/projects\/([^/]+)\/assets$/.exec(
        url.pathname,
      );
      if (req.method === "POST" && upload) {
        authorize(principal, "yamakan.project.save");
        const name = decodeURIComponent(
          String(req.headers["x-asset-name"] || ""),
        );
        // Uploads stream to disk; the declared size bounds the work up front.
        // A rejected upload closes its connection instead of draining the body.
        res.setHeader("Connection", "close");
        const length = String(req.headers["content-length"] ?? "");
        if (!/^\d{1,16}$/.test(length))
          throw new CommandError(
            "VALIDATION",
            "Uploads require a Content-Length header.",
          );
        const staged = await store.stageAsset(
          upload[1],
          name,
          req,
          Number(length),
        );
        // Variable-frame-rate video is edited only through a constant-rate
        // derivative; the asset joins the project when that job succeeds.
        if (staged.probe.variableFrameRate && staged.asset.kind === "video")
          return json(202, {
            project: await store.load(upload[1]),
            asset: null,
            job: await api.queue.submitDerivative(upload[1], staged),
          });
        return json(200, {
          project: await store.attachAsset(upload[1], staged.asset),
          asset: staged.asset,
          probe: staged.probe,
        });
      }
      const asset = /^\/api\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && asset) {
        authorize(principal, "yamakan.project.open");
        const { file, asset: a } = await store.assetFile(asset[1], asset[2]);
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
        await media(file, mime[a.kind]);
        return;
      }
      const exportMatch = /^\/api\/v1\/jobs\/([^/]+)\/artifact$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && exportMatch) {
        authorize(principal, "yamakan.job.status");
        const job = api.queue.status(exportMatch[1]);
        if (job.state !== "COMPLETED" || !job.artifact)
          throw new Error("Artifact is not complete.");
        const file = await store.file(
          job.projectId,
          ...job.artifact.split("/"),
        );
        await media(file, "video/mp4", true);
        return;
      }
      return fail(new CommandError("NOT_FOUND", "Endpoint not found."));
    }
    if (req.method !== "GET")
      return fail(new CommandError("VALIDATION", "Method not allowed."));
    // Local navigation grants a session cookie; cross-site requests were rejected above.
    res.setHeader(
      "Set-Cookie",
      `yamakan=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
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
    fail(toCommandError(e));
  }
});
// Long uploads and downloads stay open while data flows; idle sockets close.
server.requestTimeout = 0;
server.setTimeout(120_000);
server.listen(port, "127.0.0.1", () =>
  console.log(`Yamakan is running at ${origin}; workspace ${root}`),
);
const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  const drained = api.queue.close();
  const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
  await drained;
  await stopped;
  closeWorkers();
  store.close();
  lock.release();
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
