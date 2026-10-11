import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

test("loopback API rejects unauthenticated and cross-site access; restart preserves edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "darzain-http-"));
  const port = 24318;
  const origin = `http://127.0.0.1:${port}`;
  const script = fileURLToPath(new URL("../server/main.ts", import.meta.url));
  let child: ReturnType<typeof fork> | undefined;
  async function start() {
    child = fork(script, [], {
      env: {
        ...process.env,
        DARZAIN_WORKSPACE: root,
        DARZAIN_PORT: String(port),
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
        if (String(chunk).includes("Darzain is running")) {
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
    assert.equal((await call("__proto__", {})).status, 400);
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
    await stop();
    await assert.rejects(access(path.join(root, "server.lock")));
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
