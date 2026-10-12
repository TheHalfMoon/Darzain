import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createInterface } from "node:readline";

// Every test folder is removed when the file's tests finish; each test
// waits for its server to exit first.
const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);

test("MCP stdio exposes registry tools and runs the shared command path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-mcp-"));
  bases.push(root);
  const port = 24319;
  const env = {
    ...process.env,
    YAMAKAN_WORKSPACE: root,
    YAMAKAN_PORT: String(port),
    YAMAKAN_URL: `http://127.0.0.1:${port}`,
  };
  const server = fork(
    fileURLToPath(new URL("../server/main.ts", import.meta.url)),
    [],
    { env, silent: true, windowsHide: true },
  );
  const mcp = spawn(
    process.execPath,
    [fileURLToPath(new URL("../mcp/main.ts", import.meta.url))],
    { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("startup timeout")),
        10000,
      );
      server.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Yamakan is running")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
    });
    const responses = new Map<number, (value: any) => void>();
    createInterface({ input: mcp.stdout! }).on("line", (line) => {
      const message = JSON.parse(line);
      responses.get(message.id)?.(message);
    });
    let nextId = 1;
    const request = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        responses.set(id, resolve);
        mcp.stdin!.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });

    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "yamakan-test", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "yamakan");
    mcp.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const { tools } = (await request("tools/list")).result;
    const names = tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("yamakan_project_create"));
    assert.ok(names.every((n: string) => /^[A-Za-z0-9_-]{1,64}$/.test(n)));
    assert.equal(
      tools.find((t: { name: string }) => t.name === "yamakan_project_list")
        .annotations.readOnlyHint,
      true,
    );

    const created = await request("tools/call", {
      name: "yamakan_project_create",
      arguments: { name: "MCP film" },
    });
    assert.equal(created.result.isError, undefined);
    const project = JSON.parse(created.result.content[0].text);
    assert.equal(project.name, "MCP film");

    const listed = await request("tools/call", {
      name: "yamakan_project_list",
      arguments: {},
    });
    assert.deepEqual(
      JSON.parse(listed.result.content[0].text).map(
        (p: { id: string }) => p.id,
      ),
      [project.id],
    );

    const invalid = await request("tools/call", {
      name: "yamakan_project_create",
      arguments: { name: "x", shell: "whoami" },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(JSON.parse(invalid.result.content[0].text).code, "VALIDATION");

    const unknown = await request("tools/call", {
      name: "run_command",
      arguments: { cmd: "whoami" },
    });
    assert.equal(unknown.error.code, -32602);
    assert.equal((await request("no/such/method")).error.code, -32601);
  } finally {
    mcp.stdin!.end();
    if (mcp.exitCode === null) await once(mcp, "exit");
    if (server.exitCode === null) {
      const done = once(server, "exit");
      server.send("shutdown");
      await done;
    }
  }
});
