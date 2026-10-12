import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { readFile, unlink, writeFile } from "node:fs/promises";
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
import { closePreviews, preview } from "../core/render/preview.ts";
import { assertSeparate, defaultRecoveryHome } from "../core/recovery.ts";
import { restrictToOwner } from "../core/process/access.ts";
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
// Owner-only before anything secret is written: on Windows a protected DACL
// (this user, SYSTEM, Administrators) that everything below inherits; other
// accounts of the machine are denied. A workspace that cannot be protected
// is not opened.
try {
  await restrictToOwner(root, "dir");
} catch (e) {
  console.error(
    `The workspace could not be made private to this account: ${(e as Error).message}`,
  );
  process.exit(1);
}
// The OS-owned lock is taken before the database is read and is released by
// the operating system if this process dies.
const lock = await acquireServiceLock(root);
const store = new ProjectStore(root);
await store.initialize();
// Separate credentials. Explicit local clients (CLI, MCP, SDK) read the
// bearer token file. The browser page obtains its session only through the
// launch link (an owner-only file): opening the page alone grants nothing.
// No cookie is used: browsers send cookies to every port of 127.0.0.1, so
// another local server would receive it. The page keeps the session in its
// own per-origin storage and sends it as a header; media elements, which
// cannot send headers, use a separate key that only reads media.
const sessionToken = randomBytes(32).toString("hex");
const mediaKey = randomBytes(32).toString("hex");
const clientToken = randomBytes(32).toString("hex");
const launchSecret = randomBytes(32).toString("hex");
// Written fresh each start (a stale file keeps its old mode on POSIX).
async function writeSecret(name: string, value: string) {
  const file = await safePath(root, name);
  await unlink(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT")
      throw new Error(`The ${name} file could not be replaced: ${e.message}`);
  });
  await writeFile(file, value, { mode: 0o600, flag: "wx" });
}
await writeSecret("token", clientToken);
// Backups and restored workspaces live outside the workspace folder, and
// are private to this account too.
const recoveryHome = path.resolve(env("RECOVERY") || defaultRecoveryHome(root));
try {
  await assertSeparate(root, recoveryHome);
} catch (e) {
  console.error(
    `The recovery folder must be outside the workspace: ${(e as Error).message}`,
  );
  process.exit(1);
}
try {
  if (existsSync(recoveryHome)) await restrictToOwner(recoveryHome, "dir");
} catch (e) {
  console.error(
    `The recovery folder could not be made private to this account: ${(e as Error).message}`,
  );
  process.exit(1);
}
const api = new CreativeAPI(store, { recoveryHome });
// Durable jobs: reconcile any interrupted attempts and resume queued work.
await api.queue.start();
// Crash leftovers from an earlier run (older than the grace period).
void store
  .collectGarbage()
  .catch((e: Error) =>
    console.warn("Garbage collection skipped: " + e.message),
  );
const port = Number(env("PORT") || 4318);
const origin = `http://127.0.0.1:${port}`;
// The secret travels in the fragment, which browsers never send to a server.
const launchUrl = `${origin}/#launch=${launchSecret}`;
await writeSecret("launch", `${launchUrl}\n`);
function sameToken(value: string, expected: string) {
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Media reads (asset bytes, previews, export downloads) are the only routes
// the media key opens.
const MEDIA_ROUTE =
  /^\/api\/v1\/(projects\/[^/]+\/(assets\/[^/]+|preview)|jobs\/[^/]+\/artifact)$/;
function authenticate(
  req: import("node:http").IncomingMessage,
  url: URL,
): Principal | null {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    return bearer && sameToken(bearer, clientToken)
      ? principals["local-client"]
      : null;
  }
  // Browser requests must come from the Yamakan page itself: state changes
  // carry our exact Origin; reads reject other sites and loopback ports.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return null;
  const session = req.headers["x-yamakan-session"];
  if (typeof session === "string") {
    if (!/^[a-f0-9]{64}$/.test(session) || !sameToken(session, sessionToken))
      return null;
    if (req.method !== "GET" && req.headers.origin !== origin) return null;
    return principals["browser-ui"];
  }
  const media = url.searchParams.get("media");
  if (
    media !== null &&
    req.method === "GET" &&
    MEDIA_ROUTE.test(url.pathname) &&
    /^[a-f0-9]{64}$/.test(media) &&
    sameToken(media, mediaKey)
  )
    return principals["browser-ui"];
  return null;
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
  const fail = (error: CommandError) => {
    // An error is never cached, whatever a route set before failing.
    if (!res.headersSent) res.setHeader("Cache-Control", "no-store");
    return json(httpStatus[error.code], {
      apiVersion: 1,
      requestId,
      error: {
        code: error.code,
        // The recovery folder first: by default it begins with the
        // workspace path.
        message: error.message
          .replaceAll(recoveryHome, "[recovery]")
          .replaceAll(root, "[workspace]")
          .replaceAll(projectRoot, "[application]"),
        retryable: error.retryable,
      },
    });
  };
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
          "Cache-Control": "no-store",
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
    // The page exchanges the launch secret for its session cookie. Only the
    // Yamakan page itself may do so (exact Origin), and only with the secret.
    if (req.method === "POST" && url.pathname === "/api/v1/session") {
      if (req.headers.origin !== origin)
        return fail(
          new CommandError("FORBIDDEN_ORIGIN", "Origin is not allowed."),
        );
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new CommandError("VALIDATION", "JSON content type required.");
      let launch: unknown;
      try {
        launch = JSON.parse((await body(req, 1024)).toString()).launch;
      } catch {
        throw new CommandError("VALIDATION", "Invalid session request.");
      }
      if (
        typeof launch !== "string" ||
        !/^[a-f0-9]{64}$/.test(launch) ||
        !sameToken(launch, launchSecret)
      )
        return fail(
          new CommandError("UNAUTHENTICATED", "The launch link is not valid."),
        );
      return json(200, { session: sessionToken, media: mediaKey });
    }
    if (url.pathname.startsWith("/api/")) {
      const principal = authenticate(req, url);
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
        if (staged.probe.variableFrameRate && staged.asset.kind === "video") {
          let job;
          try {
            authorize(principal, "yamakan.export.video");
            job = await api.queue.submitDerivative(upload[1], staged);
          } catch (e) {
            // No job holds the staged original, so it is released now.
            await store.discardStagedVersion(upload[1], staged.asset.id);
            throw e;
          }
          return json(202, {
            project: await store.load(upload[1]),
            asset: null,
            job,
          });
        }
        return json(200, {
          project: await store.attachAsset(upload[1], staged.asset),
          asset: staged.asset,
          probe: staged.probe,
        });
      }
      // Reference preview: a frame (PNG) or short segment (MP4) of a stored
      // revision, rendered by the export's plan compiler.
      const previewMatch = /^\/api\/v1\/projects\/([^/]+)\/preview$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && previewMatch) {
        authorize(principal, "yamakan.project.open");
        const number = (name: string, fallback?: number) => {
          const raw = url.searchParams.get(name);
          if (raw === null && fallback !== undefined) return fallback;
          if (raw === null || !/^\d{1,9}$/.test(raw))
            throw new CommandError(
              "VALIDATION",
              `${name} must be a whole number.`,
            );
          return Number(raw);
        };
        const kind = url.searchParams.get("kind") ?? "frame";
        if (kind !== "frame" && kind !== "segment")
          throw new CommandError(
            "VALIDATION",
            "kind must be frame or segment.",
          );
        // A client that leaves (a newer playhead position, a closed tab)
        // releases its render; the last one to leave stops it.
        const left = new AbortController();
        res.once("close", () => {
          if (!res.writableFinished) left.abort();
        });
        const shown = await preview(
          store,
          previewMatch[1],
          number("revision"),
          kind,
          number("start"),
          kind === "segment" ? number("frames", 60) : 1,
          left.signal,
        );
        res.setHeader("X-Preview-Start", String(shown.startFrame));
        res.setHeader("X-Preview-Frames", String(shown.frames));
        res.setHeader("X-Plan-Hash", shown.planHash);
        res.setHeader("X-Revision", String(shown.revision));
        res.setHeader("X-Preview-Cache", shown.cached ? "hit" : "miss");
        // A preview of a revision never changes.
        res.setHeader("Cache-Control", "private, max-age=3600, immutable");
        await media(shown.file, shown.contentType);
        return;
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
        // Only export renders are downloadable files.
        if (!/^exports\/[0-9a-f-]{36}\/render-\d{1,3}\.mp4$/.test(job.artifact))
          throw new CommandError("NOT_FOUND", "This job has no file artifact.");
        const file = await store.file(
          job.projectId,
          ...job.artifact.split("/"),
        );
        // Backups do not carry exports; a restored workspace exports again.
        if (!(await stat(file).catch(() => null))?.isFile())
          throw new CommandError(
            "NOT_FOUND",
            "This export's file is not in this workspace; export again.",
          );
        await media(file, "video/mp4", true);
        return;
      }
      return fail(new CommandError("NOT_FOUND", "Endpoint not found."));
    }
    if (req.method !== "GET")
      return fail(new CommandError("VALIDATION", "Method not allowed."));
    // The page itself is public application code; it grants no session.
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
  console.log(
    `Yamakan is running at ${origin}; workspace ${root}\nOpen Yamakan with the link in ${path.join(root, "launch")}`,
  ),
);
const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  const drained = Promise.all([api.queue.close(), closePreviews()]);
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
