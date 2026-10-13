// MVP journey step 14 (docs/E2E_ACCEPTANCE.md): the same operations replayed
// over REST and over MCP against one real service produce the same results,
// the same revisions, the same structured errors and the same canonical
// project bytes. Generated identifiers (project, asset, tracks, jobs) are
// mapped from the MCP run onto the REST run; nothing else is normalised.
// Media import has no MCP tool (raw bytes go to the REST upload route for
// both), and an unknown MCP tool is a JSON-RPC error by protocol design.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  execFileSync,
  fork,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { YamakanClient, YamakanError } from "../sdk/client.ts";
import { mediaTools } from "../core/process/workers.ts";

const F = 23_520_000; // flicks per 30 fps frame
// Clip, scene and shot identifiers are unique across a workspace, so each
// transport's run uses its own fixed set (mapped onto each other below).
type Ids = ReturnType<typeof idSet>;
const idSet = (run: string) => {
  const id = (n: number) =>
    `${run}${n}${run}${n}${run}${n}${run}${n}-${run}${n}${run}${n}-4${run}${n}${run}-8${run}${n}${run}-${`${run}${n}`.repeat(6)}`;
  return {
    scene: id(1),
    shot: id(2),
    title: id(3),
    title2: id(4),
    tone: id(5),
    late: id(6),
  };
};
const port = 24331;
const base = `http://127.0.0.1:${port}`;
const children: ChildProcess[] = [];
const folders: string[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill();
  await Promise.all(
    folders.map((f) => rm(f, { recursive: true, force: true })),
  );
});

type Outcome =
  { ok: true; result: any } | { ok: false; code: string; retryable: boolean };
type Transport = {
  name: string;
  call: (op: string, params: unknown, requestId?: string) => Promise<Outcome>;
};

function rest(token: string): Transport {
  const client = new YamakanClient({ baseUrl: base, token });
  return {
    name: "REST",
    call: async (op, params, requestId) => {
      try {
        return {
          ok: true,
          result: await client.call(op as never, params as never, requestId),
        };
      } catch (e) {
        if (!(e instanceof YamakanError)) throw e;
        return { ok: false, code: e.code, retryable: e.retryable };
      }
    },
  };
}

function mcp(env: NodeJS.ProcessEnv): Transport & {
  close: () => Promise<void>;
  raw: (method: string, params?: unknown) => Promise<any>;
} {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../mcp/main.ts", import.meta.url))],
    { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  children.push(child);
  const waiting = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 1;
  const raw = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    name: "MCP",
    raw,
    call: async (op, params, requestId) => {
      const reply = await raw("tools/call", {
        name: op.replaceAll(".", "_"),
        arguments: {
          ...(params as object),
          ...(requestId === undefined ? {} : { requestId }),
        },
      });
      assert.equal(reply.error, undefined, JSON.stringify(reply.error));
      const value = JSON.parse(reply.result.content[0].text);
      return reply.result.isError
        ? { ok: false, code: value.code, retryable: value.retryable }
        : { ok: true, result: value };
    },
    close: async () => {
      child.stdin!.end();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

function tenOperations(tracks: string[], audioId: string, ids: Ids) {
  const [picture, sound] = tracks;
  return [
    { type: "scene.add", sceneId: ids.scene, name: "Opening" },
    {
      type: "clip.add",
      clipId: ids.title,
      trackId: picture,
      assetId: null,
      title: "مرحبا · Hello",
      startTicks: 0,
      durationTicks: 60 * F,
      sourceStartTicks: 0,
    },
    {
      type: "clip.split",
      clipId: ids.title,
      atTicks: 30 * F,
      newClipId: ids.title2,
    },
    { type: "clip.setTitle", clipId: ids.title2, title: "Part two" },
    {
      type: "clip.add",
      clipId: ids.tone,
      trackId: sound,
      assetId: audioId,
      title: null,
      startTicks: 0,
      durationTicks: 90 * F,
      sourceStartTicks: 0,
    },
    { type: "clip.trim", clipId: ids.tone, startTicks: 15 * F },
    {
      type: "clip.setAudio",
      clipId: ids.tone,
      gainDb: -6,
      fadeInTicks: 10 * F,
      fadeOutTicks: 5 * F,
    },
    {
      type: "shot.add",
      sceneId: ids.scene,
      shotId: ids.shot,
      name: "Wide",
      clipIds: [ids.title],
    },
    { type: "clip.move", clipId: ids.title2, startTicks: 45 * F },
    { type: "track.update", trackId: sound, locked: true },
  ];
}

// The journey (steps 2-11 that have commands), recorded as a transcript of
// every request and its outcome.
async function journey(
  t: Transport,
  token: string,
  wav: Buffer,
  uiHeaders: Record<string, string>,
  ids: Ids,
) {
  const log: { step: string; outcome: unknown }[] = [];
  const record = (step: string, outcome: unknown) => {
    log.push({ step, outcome });
    return outcome;
  };
  const must = async (op: string, params: unknown, requestId?: string) => {
    const o = await t.call(op, params, requestId);
    assert.ok(o.ok, `${t.name} ${op}: ${JSON.stringify(o)}`);
    return (o as { result: any }).result;
  };

  const project = await must(
    "yamakan.project.create",
    { name: "Parity" },
    `${t.name}-create-1`,
  );
  record("create", project);
  record(
    "create replayed",
    await t.call(
      "yamakan.project.create",
      { name: "Parity" },
      `${t.name}-create-1`,
    ),
  );
  // Raw media goes to the REST upload route for both transports.
  const upload = await fetch(`${base}/api/v1/projects/${project.id}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Asset-Name": "tone.wav" },
    body: new Uint8Array(wav),
  });
  assert.equal(upload.status, 200);
  const { asset } = await upload.json();
  const head = await must("yamakan.project.open", { projectId: project.id });
  record("open after import", head);
  const tracks = head.tracks.map((x: { id: string }) => x.id);
  const batch = {
    projectId: project.id,
    expectedRevision: head.revision,
    operations: tenOperations(tracks, asset.id, ids),
  };
  record(
    "batch",
    await t.call("yamakan.project.applyBatch", batch, `${t.name}-batch-1`),
  );
  record(
    "batch replayed",
    await t.call("yamakan.project.applyBatch", batch, `${t.name}-batch-1`),
  );
  record(
    "batch id reused with other input",
    await t.call(
      "yamakan.project.applyBatch",
      { ...batch, operations: batch.operations.slice(0, 1) },
      `${t.name}-batch-1`,
    ),
  );
  record("stale batch", await t.call("yamakan.project.applyBatch", batch));
  record(
    "invalid input",
    await t.call("yamakan.project.applyBatch", { ...batch, shell: "whoami" }),
  );
  record(
    "invalid requestId",
    await t.call("yamakan.project.open", { projectId: project.id }, "bad id!"),
  );
  record(
    "missing project",
    await t.call("yamakan.project.open", {
      projectId: "77777777-7777-4777-8777-777777777777",
    }),
  );
  const edited = await must("yamakan.project.open", { projectId: project.id });
  record(
    "undo",
    await t.call(
      "yamakan.project.undo",
      { projectId: project.id, expectedRevision: edited.revision },
      `${t.name}-undo-1`,
    ),
  );
  record(
    "redo",
    await t.call(
      "yamakan.project.redo",
      { projectId: project.id, expectedRevision: edited.revision + 1 },
      `${t.name}-redo-1`,
    ),
  );
  record(
    "stale undo",
    await t.call("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: edited.revision,
    }),
  );
  const history = await must("yamakan.project.history", {
    projectId: project.id,
    limit: 20,
  });
  record("history", history);
  record(
    "restore",
    await t.call(
      "yamakan.project.restore",
      {
        projectId: project.id,
        revision: edited.revision,
        expectedHeadFingerprint: history.headFingerprint,
      },
      `${t.name}-restore-1`,
    ),
  );
  // Per-writer undo: a batch the browser editor applied is not this client's
  // to undo.
  const current = await must("yamakan.project.open", { projectId: project.id });
  const ui = await fetch(`${base}/api/v1/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, ...uiHeaders },
    body: JSON.stringify({
      apiVersion: 1,
      operation: "yamakan.project.applyBatch",
      parameters: {
        projectId: project.id,
        expectedRevision: current.revision,
        operations: [
          {
            type: "clip.add",
            clipId: ids.late,
            trackId: tracks[0],
            assetId: null,
            title: "Editor",
            startTicks: 90 * F,
            durationTicks: 30 * F,
            sourceStartTicks: 0,
          },
        ],
      },
    }),
  });
  assert.equal(ui.status, 200, await ui.clone().text());
  record(
    "undo of another writer's batch",
    await t.call("yamakan.project.undo", {
      projectId: project.id,
      expectedRevision: current.revision + 1,
    }),
  );
  // Export and job control.
  const job = await must("yamakan.export.video", {
    projectId: project.id,
    idempotencyKey: "parity",
  });
  record("export queued", job);
  record(
    "export resubmitted",
    await t.call("yamakan.export.video", {
      projectId: project.id,
      idempotencyKey: "parity",
    }),
  );
  let status = job;
  for (
    let i = 0;
    i < 1200 && !["COMPLETED", "FAILED", "CANCELLED"].includes(status.state);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 100));
    status = await must("yamakan.job.status", { jobId: job.id });
  }
  record("export finished", status);
  record(
    "cancel after completion",
    await t.call("yamakan.job.cancel", { jobId: job.id }),
  );
  const mp4 = Buffer.from(
    await (
      await fetch(`${base}/api/v1/jobs/${job.id}/artifact`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).arrayBuffer(),
  );
  const canonical = await must("yamakan.project.export", {
    projectId: project.id,
  });
  record("canonical export", canonical);
  return { log, project, asset, tracks, job, mp4, canonical };
}

test("REST and MCP replay the journey with identical results, errors and canonical bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-parity-"));
  folders.push(root);
  const env = {
    ...process.env,
    YAMAKAN_WORKSPACE: path.join(root, "workspace"),
    YAMAKAN_PORT: String(port),
    YAMAKAN_URL: base,
  };
  const server = fork(
    fileURLToPath(new URL("../server/main.ts", import.meta.url)),
    [],
    {
      env,
      silent: true,
      windowsHide: true,
    },
  );
  children.push(server);
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on(
      "data",
      (c) => String(c).includes("Yamakan is running") && resolve(),
    );
    server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const wav = path.join(root, "tone.wav");
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
      "sine=frequency=440:duration=4",
      wav,
    ],
    { windowsHide: true },
  );
  const wavBytes = await readFile(wav);
  const workspace = env.YAMAKAN_WORKSPACE;
  const token = (await readFile(path.join(workspace, "token"), "utf8")).trim();
  // The launch file holds the link; its fragment carries the secret.
  const launch = /#launch=([a-f0-9]{64})/.exec(
    await readFile(path.join(workspace, "launch"), "utf8"),
  )![1];
  const session = await (
    await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ launch }),
    })
  ).json();
  const uiHeaders = { "X-Yamakan-Session": session.session };

  const viaMcp = mcp(env);
  try {
    const init = await viaMcp.raw("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "parity", version: "1" },
    });
    assert.equal(init.result.serverInfo.name, "yamakan");
    // Every registry command is an MCP tool with the same input contract
    // plus the optional requestId.
    const catalog = await (
      await fetch(`${base}/api/v1/tools`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const { tools } = (await viaMcp.raw("tools/list")).result;
    assert.deepEqual(
      tools.map((x: { title: string }) => x.title).sort(),
      catalog.tools.map((x: { name: string }) => x.name).sort(),
    );
    for (const tool of tools) {
      const command = catalog.tools.find(
        (x: { name: string }) => x.name === tool.title,
      );
      const { requestId, ...properties } = tool.inputSchema.properties;
      assert.ok(requestId);
      assert.deepEqual(
        { ...tool.inputSchema, properties },
        command.inputSchema,
        tool.title,
      );
      assert.equal(tool.annotations.readOnlyHint, !command.mutation);
    }

    const idsA = idSet("a");
    const idsB = idSet("b");
    const a = await journey(rest(token), token, wavBytes, uiHeaders, idsA);
    const b = await journey(viaMcp, token, wavBytes, uiHeaders, idsB);

    // Request IDs belong to the principal, not the transport: the REST
    // run's create, replayed over MCP, returns the same project.
    assert.deepEqual(
      await viaMcp.call(
        "yamakan.project.create",
        { name: "Parity" },
        "REST-create-1",
      ),
      { ok: true, result: a.project },
    );
    // Map the MCP run's generated identifiers onto the REST run's.
    const mapping = new Map<string, string>([
      [b.project.id, a.project.id],
      [b.asset.id, a.asset.id],
      [b.job.id, a.job.id],
      ...Object.keys(idsA).map(
        (k) => [idsB[k as keyof Ids], idsA[k as keyof Ids]] as [string, string],
      ),
      ...b.tracks.map(
        (id: string, i: number) => [id, a.tracks[i]] as [string, string],
      ),
    ]);
    const mapped = (value: unknown) => {
      let text = JSON.stringify(value);
      for (const [from, to] of mapping) text = text.replaceAll(from, to);
      return JSON.parse(text);
    };
    // Compared for shape only: timestamps, and hashes computed over content
    // that contains each run's own identifiers (the head fingerprint, the
    // render plan hash). That content itself is compared byte for byte
    // below, through the canonical export.
    const scrub = (value: any): any =>
      Array.isArray(value)
        ? value.map(scrub)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [
                k,
                /^(createdAt|updatedAt|savedAt|at)$/.test(k) &&
                typeof v === "string"
                  ? "<time>"
                  : /^(headFingerprint|expectedHeadFingerprint|planHash)$/.test(
                        k,
                      ) &&
                      typeof v === "string" &&
                      /^[a-f0-9]{64}$/.test(v)
                    ? "<hash over identifiers>"
                    : scrub(v),
              ]),
            )
          : value;
    assert.equal(a.log.length, b.log.length);
    for (let i = 0; i < a.log.length; i++)
      assert.deepEqual(scrub(mapped(b.log[i])), scrub(a.log[i]), a.log[i].step);

    // The structured errors each step produced, in order.
    const step = (log: typeof a.log, name: string) =>
      log.find((x) => x.step === name)!.outcome as any;
    const codes = a.log
      .filter((x) => (x.outcome as Outcome)?.ok === false)
      .map((x) => `${x.step}: ${(x.outcome as { code: string }).code}`);
    assert.deepEqual(codes, [
      "batch id reused with other input: IDEMPOTENCY_MISMATCH",
      "stale batch: REVISION_CONFLICT",
      "invalid input: VALIDATION",
      "invalid requestId: VALIDATION",
      "missing project: NOT_FOUND",
      "stale undo: REVISION_CONFLICT",
      "undo of another writer's batch: REVISION_CONFLICT",
    ]);
    // Cancelling a finished job changes nothing and returns it as it was.
    assert.equal(
      step(a.log, "cancel after completion").result.state,
      "COMPLETED",
    );
    // Replays returned the original results.
    assert.deepEqual(step(a.log, "batch replayed"), step(a.log, "batch"));
    assert.deepEqual(
      step(a.log, "create replayed").result,
      step(a.log, "create"),
    );
    // Identical canonical project bytes and identical exported media (real
    // MP4 files, not empty downloads).
    for (const mp4 of [a.mp4, b.mp4]) {
      assert.ok(mp4.length > 10_000, `${mp4.length} bytes`);
      assert.equal(mp4.toString("latin1", 4, 8), "ftyp");
    }
    assert.equal(
      JSON.stringify(mapped(b.canonical)),
      JSON.stringify(a.canonical),
    );
    assert.equal(
      createHash("sha256").update(b.mp4).digest("hex"),
      createHash("sha256").update(a.mp4).digest("hex"),
    );
    await writeFile(
      path.join(root, "transcript.json"),
      JSON.stringify({ rest: a.log, mcp: b.log }, null, 2),
    );

    // A wrong credential fails the same way on both transports.
    const badRest = await rest("0".repeat(64)).call("yamakan.project.list", {});
    // MCP reads its credential from the workspace; this one holds a wrong one.
    const badRoot = path.join(root, "bad");
    await mkdir(badRoot);
    await writeFile(path.join(badRoot, "token"), "0".repeat(64));
    const badMcp = mcp({ ...env, YAMAKAN_WORKSPACE: badRoot });
    try {
      await badMcp.raw("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bad", version: "1" },
      });
      assert.deepEqual(await badMcp.call("yamakan.project.list", {}), badRest);
    } finally {
      await badMcp.close();
    }
    assert.deepEqual(badRest, {
      ok: false,
      code: "UNAUTHENTICATED",
      retryable: false,
    });
    // An unknown operation: a VALIDATION error over REST, a JSON-RPC
    // invalid-params error over MCP (no such tool exists to call).
    assert.deepEqual(await rest(token).call("yamakan.no.such", {}), {
      ok: false,
      code: "VALIDATION",
      retryable: false,
    });
    assert.equal(
      (
        await viaMcp.raw("tools/call", {
          name: "yamakan_no_such",
          arguments: {},
        })
      ).error.code,
      -32602,
    );
  } finally {
    await viaMcp.close();
    if (server.exitCode === null) {
      const done = once(server, "exit");
      server.send("shutdown");
      await done;
    }
  }
});
