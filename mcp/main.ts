// Yamakan MCP stdio server. It is an explicit local client of the running
// Yamakan service: tools are derived from the service catalog and every call
// goes through the same command registry, scopes and validation as the UI.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { YamakanClient, YamakanError } from "../sdk/client.ts";
import type { Operation } from "../sdk/client.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const env = (key: string) =>
  process.env[`YAMAKAN_${key}`] || process.env[`DARZAIN_${key}`];
const url = env("URL") || "http://127.0.0.1:4318";
if (new URL(url).hostname !== "127.0.0.1")
  throw new Error("MCP connects only to the local Yamakan server.");
const root = path.resolve(
  env("WORKSPACE") ||
    (!existsSync(".yamakan") && existsSync(".darzain")
      ? ".darzain"
      : ".yamakan"),
);
// The service rotates its credential on restart, so read it for every call.
const client = async () =>
  new YamakanClient({
    baseUrl: url,
    token: (await readFile(path.join(root, "token"), "utf8")).trim(),
  });

// MCP clients commonly restrict tool names to [A-Za-z0-9_-].
const toolName = (operation: string) => operation.replaceAll(".", "_");

type Message = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: Message["id"], result: unknown) =>
  send({ jsonrpc: "2.0", id, result });
const error = (id: Message["id"], code: number, message: string) =>
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

let operations: Map<string, Operation> | null = null;
async function tools() {
  const catalog = await (await client()).catalog();
  operations = new Map(catalog.tools.map((t) => [toolName(t.name), t.name]));
  return catalog.tools.map((t) => ({
    name: toolName(t.name),
    title: t.name,
    description: `${t.summary} Requires scope ${t.scope}.`,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !t.mutation },
  }));
}

async function handle(message: Message) {
  const { id, method, params = {} } = message;
  const notification = id === undefined;
  switch (method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "yamakan", title: "Yamakan", version: "0.1.0" },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: await tools() });
    case "tools/call": {
      if (!operations) await tools();
      const operation = operations!.get(String(params.name));
      if (!operation) return error(id, -32602, "Unknown tool.");
      try {
        const result = await (
          await client()
        ).call(operation, (params.arguments ?? {}) as never);
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (e) {
        if (!(e instanceof YamakanError)) throw e;
        // Tool failures are results the model can read, not protocol errors.
        return reply(id, {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: e.code,
                message: e.message,
                retryable: e.retryable,
              }),
            },
          ],
        });
      }
    }
    default:
      if (!notification) error(id, -32601, "Method not found.");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (
    buffer.length > RESOURCE_POLICY.enforced.requestBytes &&
    !buffer.includes("\n")
  ) {
    buffer = "";
    error(null, -32700, "Message exceeds the request size limit.");
    return;
  }
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, "Parse error.");
      continue;
    }
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
      error(message?.id, -32600, "Invalid request.");
      continue;
    }
    // Transport failures (no token file, service not listening) never echo host paths.
    handle(message).catch(() =>
      error(
        message.id,
        -32603,
        "Yamakan service is not running or its workspace credential is unavailable.",
      ),
    );
  }
});
process.stdin.on("end", () => process.exit(0));
