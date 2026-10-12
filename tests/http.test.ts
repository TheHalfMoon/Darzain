import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, readFile, access, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mediaTools } from "../core/process/workers.ts";
import { readableByOtherAccounts } from "../core/process/access.ts";

test("loopback API rejects unauthenticated and cross-site access; restart preserves edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-http-"));
  const port = 24318;
  const origin = `http://127.0.0.1:${port}`;
  const script = fileURLToPath(new URL("../server/main.ts", import.meta.url));
  let child: ReturnType<typeof fork> | undefined;
  async function start() {
    child = fork(script, [], {
      env: {
        ...process.env,
        YAMAKAN_WORKSPACE: root,
        YAMAKAN_PORT: String(port),
      },
      silent: true,
      windowsHide: true,
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => (errors += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Server startup timeout: ${errors}`)),
        10000,
      );
      child!.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Yamakan is running")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${errors}`));
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const done = once(child, "exit");
    child.send("shutdown");
    await done;
  }
  try {
    await start();
    assert.equal((await fetch(`${origin}/api/v1/tools`)).status, 401);
    const token = await readFile(path.join(root, "token"), "utf8");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${origin}/api/v1/tools`, {
          headers: { ...headers, Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/v1/tools`, {
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    const call = async (name: string, args: unknown) =>
      fetch(`${origin}/api/v1/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: args }),
      });
    assert.equal(
      (await call("darzain.project.open", { projectId: "../../outside" }))
        .status,
      400,
    );
    const unknown = await call("__proto__", {});
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, "VALIDATION");

    // Browser session and local-client credentials are separate authentication
    // paths. Opening the page grants nothing: the session comes only from the
    // launch secret, exchanged by the Yamakan page itself.
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(
      page.headers.get("set-cookie"),
      null,
      "no cookie for a page load",
    );
    const launchUrl = (
      await readFile(path.join(root, "launch"), "utf8")
    ).trim();
    const launch = /#launch=([a-f0-9]{64})$/.exec(launchUrl)?.[1];
    assert.ok(launch, "the launch file holds the launch link");
    assert.ok(launchUrl.startsWith(`${origin}/#launch=`));
    const session = (secret: string, extra: Record<string, string> = {}) =>
      fetch(`${origin}/api/v1/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...extra,
        },
        body: JSON.stringify({ launch: secret }),
      });
    assert.equal((await session("0".repeat(64))).status, 401);
    assert.equal(
      (await session(token.trim())).status,
      401,
      "the client token is not a launch secret",
    );
    // Another loopback port (or any other origin) cannot exchange it.
    assert.equal(
      (await session(launch!, { Origin: "http://127.0.0.1:1" })).status,
      403,
    );
    const noOrigin = await fetch(`${origin}/api/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ launch }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers.get("set-cookie"), null);
    const granted = await session(launch!);
    assert.equal(granted.status, 204);
    const cookie = /yamakan=([a-f0-9]{64}); HttpOnly; SameSite=Strict/.exec(
      granted.headers.get("set-cookie") || "",
    )?.[1];
    assert.ok(cookie, "the launch secret grants an HttpOnly session cookie");
    assert.notEqual(cookie, token, "browser and client credentials differ");
    assert.notEqual(cookie, launch, "the session is not the launch secret");
    // The client token, the launch link and the database are private to
    // this account: another account of the machine is denied (Windows), or
    // the modes exclude everyone else (POSIX).
    const secrets = ["token", "launch", "workspace.sqlite"].map((name) =>
      path.join(root, name),
    );
    if (process.platform === "win32")
      for (const file of [root, ...secrets])
        assert.equal(await readableByOtherAccounts(file), false, file);
    else {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      for (const file of secrets.slice(0, 2))
        assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    }
    const envelope = JSON.stringify({
      apiVersion: 1,
      operation: "yamakan.project.list",
      requestId: "auth-check-1",
      parameters: {},
    });
    const viaCookie = (extra: Record<string, string>) =>
      fetch(`${origin}/api/v1/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `yamakan=${cookie}`,
          ...extra,
        },
        body: envelope,
      });
    assert.equal(
      (await viaCookie({})).status,
      401,
      "cookie mutation path requires a same-origin page request",
    );
    const fromPage = await viaCookie({ Origin: origin });
    assert.equal(fromPage.status, 200);
    assert.equal((await fromPage.json()).requestId, "auth-check-1");
    // Fetch Metadata alone never authorizes a cookie state change.
    assert.equal(
      (await viaCookie({ "Sec-Fetch-Site": "same-origin" })).status,
      401,
    );
    const crossCredential = async (h: Record<string, string>) =>
      (await fetch(`${origin}/api/v1/tools`, { headers: h })).status;
    assert.equal(await crossCredential({ Cookie: `yamakan=${cookie}` }), 200);
    assert.equal(
      await crossCredential({
        Cookie: `yamakan=${cookie}`,
        "Sec-Fetch-Site": "same-site",
      }),
      401,
      "another loopback port is same-site but not same-origin",
    );
    const badOrigin = await fetch(`${origin}/api/v1/tools`, {
      headers: { ...headers, Origin: "http://127.0.0.1:1" },
    });
    assert.equal((await badOrigin.json()).error.code, "FORBIDDEN_ORIGIN");
    const malformedName = await fetch(
      `${origin}/api/v1/projects/${crypto.randomUUID()}/assets`,
      {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "X-Asset-Name": "%E0%A4%A",
        },
        body: "x",
      },
    );
    assert.equal(malformedName.status, 400);
    assert.equal((await malformedName.json()).error.code, "VALIDATION");
    assert.equal(await crossCredential({ Cookie: `yamakan=${token}` }), 401);
    assert.equal(
      await crossCredential({ Authorization: `Bearer ${cookie}` }),
      401,
    );
    assert.equal(
      await crossCredential({ Authorization: `Basic ${token}` }),
      401,
    );
    const catalog = await (
      await fetch(`${origin}/api/v1/tools`, { headers })
    ).json();
    // The local CLI authenticates with the owner-only token file.
    const listed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("../cli/main.ts", import.meta.url)),
          "yamakan.project.list",
          "{}",
        ],
        {
          env: { ...process.env, YAMAKAN_URL: origin, YAMAKAN_WORKSPACE: root },
          windowsHide: true,
        },
      ).toString(),
    );
    assert.ok(Array.isArray(listed));
    assert.equal(catalog.service, "yamakan");
    assert.match(catalog.resourcePolicy.hash, /^[a-f0-9]{64}$/);
    assert.ok(
      catalog.tools.every(
        (t: { name: string; scope: string }) =>
          t.name.startsWith("yamakan.") && t.scope,
      ),
    );

    const created = await (
      await call("darzain.project.create", { name: "Restart evidence" })
    ).json();
    created.result.name = "Saved before shutdown";
    const saved = await (
      await call("darzain.project.save", {
        project: created.result,
        expectedRevision: 0,
      })
    ).json();
    assert.equal(saved.result.revision, 1);
    const stale = await call("yamakan.project.save", {
      project: created.result,
      expectedRevision: 0,
    });
    assert.equal(stale.status, 409);
    assert.deepEqual((await stale.json()).error, {
      code: "REVISION_CONFLICT",
      message: "Revision conflict; reopen before saving.",
      retryable: false,
    });
    const mediaProject = await (
      await call("darzain.project.create", { name: "Range fixture" })
    ).json();
    const wav = path.join(root, "range.wav");
    execFileSync(
      process.env.DARZAIN_FFMPEG || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-threads",
        "1",
        wav,
      ],
      { windowsHide: true },
    );
    const wavBytes = await readFile(wav);
    const uploaded = await (
      await fetch(
        `${origin}/api/v1/projects/${mediaProject.result.id}/assets`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Asset-Name": "range.wav",
          },
          body: wavBytes,
        },
      )
    ).json();
    assert.ok(uploaded.asset);
    const assetUrl = `${origin}/api/v1/projects/${mediaProject.result.id}/assets/${uploaded.asset.id}`;
    const part = await fetch(assetUrl, {
      headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-15" },
    });
    assert.equal(part.status, 206);
    assert.equal(
      part.headers.get("content-range"),
      `bytes 0-15/${wavBytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await part.arrayBuffer()),
      wavBytes.subarray(0, 16),
    );
    const suffix = await fetch(assetUrl, {
      headers: { Authorization: `Bearer ${token}`, Range: "bytes=-16" },
    });
    assert.equal(suffix.status, 206);
    assert.deepEqual(
      Buffer.from(await suffix.arrayBuffer()),
      wavBytes.subarray(-16),
    );
    assert.equal(
      (
        await fetch(assetUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${wavBytes.length}-`,
          },
        })
      ).status,
      416,
    );
    assert.equal(
      (
        await fetch(assetUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: "bytes=0-15,20-30",
          },
        })
      ).status,
      416,
    );
    // A second service on the same workspace is refused while the first lives.
    const rival = fork(script, [], {
      env: {
        ...process.env,
        YAMAKAN_WORKSPACE: root,
        YAMAKAN_PORT: String(port + 1),
      },
      silent: true,
      windowsHide: true,
    });
    let rivalErrors = "";
    rival.stderr?.on("data", (chunk) => (rivalErrors += String(chunk)));
    const [rivalCode] = await once(rival, "exit");
    assert.notEqual(rivalCode, 0);
    assert.match(rivalErrors, /already owns this workspace/);
    // A hard kill leaves no lock that needs manual deletion before restart.
    const killed = once(child!, "exit");
    child!.kill("SIGKILL");
    await killed;
    await access(path.join(root, "service.lock"));
    await start();
    assert.equal(
      (await fetch(`${origin}/api/v1/tools`, { headers })).status,
      401,
      "Session credentials rotate on restart",
    );
    const nextToken = await readFile(path.join(root, "token"), "utf8");
    const reopened = await fetch(`${origin}/api/v1/call`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${nextToken}` },
      body: JSON.stringify({
        name: "darzain.project.open",
        arguments: { projectId: created.result.id },
      }),
    });
    assert.deepEqual((await reopened.json()).result, saved.result);
  } finally {
    await stop();
  }
});

test("a VFR upload returns 202 with a conversion job; the converted asset joins the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-http-vfr-"));
  const port = 24319;
  const origin = `http://127.0.0.1:${port}`;
  const script = fileURLToPath(new URL("../server/main.ts", import.meta.url));
  const child = fork(script, [], {
    env: {
      ...process.env,
      YAMAKAN_WORKSPACE: root,
      YAMAKAN_PORT: String(port),
    },
    silent: true,
    windowsHide: true,
  });
  try {
    let errors = "";
    child.stderr?.on("data", (chunk) => (errors += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Server startup timeout: ${errors}`)),
        10000,
      );
      child.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Yamakan is running")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const token = await readFile(path.join(root, "token"), "utf8");
    const call = async (name: string, args: unknown) =>
      (
        await (
          await fetch(`${origin}/api/v1/call`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, arguments: args }),
          })
        ).json()
      ).result;
    const project = await call("yamakan.project.create", { name: "VFR" });
    const vfr = path.join(root, "vfr.mp4");
    execFileSync(
      mediaTools().ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=30:duration=2",
        "-vf",
        "select='not(mod(n\\,3))+eq(n\\,1)'",
        "-fps_mode",
        "vfr",
        "-pix_fmt",
        "yuv420p",
        vfr,
      ],
      { windowsHide: true },
    );
    const bytes = await readFile(vfr);
    const upload = await fetch(
      `${origin}/api/v1/projects/${project.id}/assets`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Asset-Name": "vfr.mp4",
          "Content-Length": String(bytes.length),
        },
        body: bytes,
      },
    );
    assert.equal(upload.status, 202);
    const accepted = await upload.json();
    assert.equal(accepted.asset, null);
    assert.equal(accepted.project.assets.length, 0);
    let job = accepted.job;
    for (
      let t = 0;
      t < 60000 && ["QUEUED", "RUNNING"].includes(job.state);
      t += 100
    ) {
      await new Promise((r) => setTimeout(r, 100));
      job = await call("yamakan.job.status", { jobId: job.id });
    }
    assert.equal(job.state, "COMPLETED", job.error ?? "");
    const opened = await call("yamakan.project.open", {
      projectId: project.id,
    });
    assert.equal(opened.assets.length, 1);
    assert.equal(job.artifact, `asset:${opened.assets[0].id}`);
    // A conversion job has no downloadable file.
    const artifact = await fetch(`${origin}/api/v1/jobs/${job.id}/artifact`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(artifact.status, 404);
  } finally {
    if (child.exitCode === null) {
      const done = once(child, "exit");
      child.send("shutdown");
      await done;
    }
  }
});

test("the preview route serves plan-compiled frames and segments to authenticated clients only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-http-preview-"));
  const port = 24321;
  const origin = `http://127.0.0.1:${port}`;
  const script = fileURLToPath(new URL("../server/main.ts", import.meta.url));
  const child = fork(script, [], {
    env: {
      ...process.env,
      YAMAKAN_WORKSPACE: root,
      YAMAKAN_PORT: String(port),
    },
    silent: true,
    windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Server startup timeout")),
        10000,
      );
      child.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Yamakan is running")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const token = await readFile(path.join(root, "token"), "utf8");
    const auth = { Authorization: `Bearer ${token}` };
    const call = async (name: string, args: unknown) =>
      (
        await (
          await fetch(`${origin}/api/v1/call`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ name, arguments: args }),
          })
        ).json()
      ).result;
    const created = await call("yamakan.project.create", { name: "Preview" });
    const saved = await call("yamakan.project.save", {
      project: {
        ...created,
        width: 320,
        height: 180,
        clips: [
          {
            id: crypto.randomUUID(),
            trackId: created.tracks[0].id,
            assetId: null,
            startFrame: 0,
            durationFrames: 60,
            sourceFrame: 0,
            title: "Preview",
          },
        ],
      },
      expectedRevision: created.revision,
    });
    const at = (query: string) =>
      `${origin}/api/v1/projects/${saved.id}/preview?revision=${saved.revision}&${query}`;
    assert.equal((await fetch(at("start=10"))).status, 401);
    const frame = await fetch(at("start=10"), { headers: auth });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/png");
    assert.match(frame.headers.get("x-plan-hash") ?? "", /^[a-f0-9]{64}$/);
    assert.equal(frame.headers.get("x-preview-cache"), "miss");
    const bytes = Buffer.from(await frame.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
    assert.equal(
      (await fetch(at("start=10"), { headers: auth })).headers.get(
        "x-preview-cache",
      ),
      "hit",
    );
    // Past the saved timeline: its last frame, said in a header.
    const past = await fetch(at("start=600"), { headers: auth });
    assert.equal(past.status, 200);
    assert.equal(past.headers.get("x-preview-start"), "59");
    await past.arrayBuffer();
    const segment = await fetch(at("kind=segment&start=0&frames=30"), {
      headers: auth,
    });
    assert.equal(segment.status, 200);
    assert.equal(segment.headers.get("content-type"), "video/mp4");
    for (const bad of [
      "start=-1",
      "start=x",
      "kind=gif&start=1",
      "kind=segment&start=0&frames=151",
    ])
      assert.equal((await fetch(at(bad), { headers: auth })).status, 400, bad);
  } finally {
    if (child.exitCode === null) {
      const done = once(child, "exit");
      child.send("shutdown");
      await done;
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
