import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  commands,
  catalog,
  execute,
  resolveOperation,
  RESOURCE_POLICY_HASH,
  Scopes,
} from "../core/command/registry.ts";
import type { Principal, Scope } from "../core/command/registry.ts";
import { parseEnvelope } from "../core/command/envelope.ts";
import { CommandError, toCommandError } from "../core/command/errors.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";
import { canonicalJson, sha256Hex } from "../core/donors/ninerr/canonical.ts";
import { ProjectStore } from "../core/store.ts";
import { JobSupervisor } from "../core/jobs.ts";
// @ts-expect-error The guard is a plain .mjs module without declarations.
import { checkImports } from "../scripts/import-guard.mjs";

// Every test folder is removed when the file's tests finish, after the
// stores and queues opened in it close (Windows cannot delete them open).
const bases: string[] = [];
const handles: { close(): unknown }[] = [];
after(async () => {
  for (const handle of handles.reverse()) await handle.close();
  await Promise.all(bases.map((b) => rm(b, { recursive: true, force: true })));
});

const principal = (...scopes: Scope[]): Principal => ({
  id: "local-client",
  scopes: new Set(scopes),
});

test("every command input is strict, bounded and free of executable or path parameters", () => {
  const forbiddenName =
    /^(cmd|command|shell|args?|argv|filter|filters|filtergraph|filter_complex|path|file|filename|url|uri|script|code|exec)$/i;
  const visit = (schema: any, where: string) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "object") {
      assert.equal(
        schema.additionalProperties,
        false,
        `${where} must reject unknown properties`,
      );
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        assert.doesNotMatch(key, forbiddenName, `${where}.${key}`);
        visit(child, `${where}.${key}`);
      }
    }
    if (schema.type === "string")
      assert.ok(
        schema.maxLength !== undefined ||
          schema.pattern !== undefined ||
          schema.enum !== undefined ||
          schema.const !== undefined,
        `${where} must be a bounded string`,
      );
    if (schema.type === "array")
      assert.ok(schema.maxItems !== undefined, `${where} must be bounded`);
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
      const value = schema[key];
      if (Array.isArray(value))
        value.forEach((v, i) => visit(v, `${where}.${key}[${i}]`));
      else visit(value, `${where}.${key}`);
    }
  };
  const tools = catalog();
  assert.equal(tools.length, Object.keys(commands).length);
  for (const tool of tools) {
    assert.match(tool.name, /^yamakan\.[a-z]+\.[a-z][a-zA-Z]*$/);
    assert.ok(Scopes.includes(tool.scope as Scope));
    visit(tool.inputSchema, tool.name);
  }
});

test("operations resolve canonical and legacy names only", () => {
  assert.equal(
    resolveOperation("yamakan.project.list"),
    "yamakan.project.list",
  );
  assert.equal(
    resolveOperation("darzain.project.list"),
    "yamakan.project.list",
  );
  for (const bad of [
    "__proto__",
    "constructor",
    "yamakan.__proto__",
    "darzain.constructor",
    "run_command",
    "",
    42,
    null,
    "x".repeat(81),
  ])
    assert.throws(
      () => resolveOperation(bad),
      (e: unknown) => e instanceof CommandError && e.code === "VALIDATION",
    );
});

test("scopes are enforced before input validation and execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yamakan-scope-"));
  bases.push(root);
  const store = new ProjectStore(root);
  handles.push(store);
  await store.initialize();
  const queue = new JobSupervisor(store);
  handles.push(queue);
  const readOnly = { store, queue, principal: principal("project:read") };
  await assert.rejects(
    execute(readOnly, "yamakan.project.create", { name: "Denied" }),
    (e: unknown) => e instanceof CommandError && e.code === "SCOPE_DENIED",
  );
  await assert.rejects(
    execute(readOnly, "yamakan.export.video", { bogus: true }),
    (e: unknown) => e instanceof CommandError && e.code === "SCOPE_DENIED",
  );
  assert.deepEqual(await store.list(), [], "denied command had no effect");
  const listed = await execute(readOnly, "darzain.project.list", {});
  assert.equal(listed.operation, "yamakan.project.list");
  const writer = { store, queue, principal: principal(...Scopes) };
  await assert.rejects(
    execute(writer, "yamakan.project.create", { name: "x", extra: 1 }),
    (e: unknown) =>
      e instanceof Error && toCommandError(e).code === "VALIDATION",
  );
  await queue.close();
});

test("command envelopes are strict and accept the legacy body", () => {
  const e = parseEnvelope({
    apiVersion: 1,
    operation: "yamakan.project.list",
    requestId: "req-1",
    parameters: {},
  });
  assert.deepEqual(e, {
    operation: "yamakan.project.list",
    requestId: "req-1",
    clientRequestId: true,
    parameters: {},
  });
  const legacy = parseEnvelope({ name: "darzain.project.list" });
  assert.equal(legacy.operation, "darzain.project.list");
  assert.match(legacy.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(legacy.clientRequestId, false);
  for (const bad of [
    { apiVersion: 2, operation: "yamakan.project.list" },
    { apiVersion: 1, operation: "yamakan.project.list", principalId: "root" },
    { apiVersion: 1, operation: "x", requestId: "has space" },
    { name: "x", arguments: {}, extra: true },
    [],
    "yamakan.project.list",
    null,
  ])
    assert.throws(
      () => parseEnvelope(bad),
      (err: unknown) =>
        err instanceof CommandError && err.code === "VALIDATION",
    );
});

test("core failures map to stable, structured error codes", () => {
  const cases: [unknown, string][] = [
    [
      new Error("Revision conflict; reopen before saving."),
      "REVISION_CONFLICT",
    ],
    [new Error("Job not found."), "NOT_FOUND"],
    [new Error("Asset integrity check failed."), "RECOVERY_REQUIRED"],
    [new Error("Asset limit reached."), "LIMIT_EXCEEDED"],
    [new Error("Request size limit exceeded."), "LIMIT_EXCEEDED"],
    [
      new Error("Media signature does not match a supported format."),
      "MEDIA_INVALID",
    ],
    [new Error("Render queue is closing."), "UNAVAILABLE"],
    [
      Object.assign(new Error("ENOENT: C:\\secret\\x"), { code: "ENOENT" }),
      "NOT_FOUND",
    ],
    [Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }), "LIMIT_EXCEEDED"],
    [new SyntaxError("Unexpected token"), "VALIDATION"],
    [z.object({ a: z.string() }).safeParse({}).error, "VALIDATION"],
    [new Error("something unexpected"), "INTERNAL"],
    ["not an error", "INTERNAL"],
    [
      Object.assign(new Error("spawn ffprobe ENOENT"), {
        code: "ENOENT",
        syscall: "spawn ffprobe",
      }),
      "CAPABILITY_UNAVAILABLE",
    ],
    [new Error("Project head changed during reading."), "BUSY"],
    [new Error("Project head fingerprint time limit exceeded."), "BUSY"],
    [new Error("Nothing is closing here."), "INTERNAL"],
    [new URIError("URI malformed"), "VALIDATION"],
  ];
  for (const [input, code] of cases)
    assert.equal(toCommandError(input).code, code);
  assert.doesNotMatch(
    toCommandError(
      Object.assign(new Error("ENOENT: C:\\secret"), { code: "ENOENT" }),
    ).message,
    /secret/,
  );
  assert.equal(new CommandError("BUSY", "x").retryable, true);
  assert.equal(new CommandError("REVISION_CONFLICT", "x").retryable, false);
});

test("resource policy is versioned, frozen and content-addressed", () => {
  assert.equal(RESOURCE_POLICY.policy, "yamakan.resource-policy/v1");
  assert.equal(RESOURCE_POLICY_HASH, sha256Hex(canonicalJson(RESOURCE_POLICY)));
  assert.ok(Object.isFrozen(RESOURCE_POLICY.enforced));
  assert.throws(() => {
    (RESOURCE_POLICY.enforced as { requestBytes: number }).requestBytes = 1e12;
  }, TypeError);
});

test("import guard accepts the repository and rejects unsafe imports", () => {
  const policy = JSON.parse(
    readFileSync("docs/provenance/import-policy.json", "utf8"),
  );
  const entry = {
    source: "owner/repo",
    sha: "a".repeat(40),
    original: "src/a.ts",
    imported: "src/donors/x/a.ts",
    sha256: "b".repeat(64),
    importedSha256: "b".repeat(64),
    modifications: [],
  };
  const run = (files: Record<string, string>, ledger = [entry]) =>
    checkImports({
      files: Object.keys(files),
      read: (f: string) => files[f],
      ledger,
      policy,
    }) as string[];
  const clean = {
    "src/donors/x/a.ts": "export const a = /x/.exec('x');",
    "core/process/owner.ts": 'import { execFile } from "node:child_process";',
  };
  assert.deepEqual(run(clean), []);
  const expectViolation = (
    files: Record<string, string>,
    pattern: RegExp,
    ledger = [entry],
  ) =>
    assert.ok(
      run({ ...clean, ...files }, ledger).some((v) => pattern.test(v)),
      `expected ${pattern}`,
    );
  expectViolation(
    { "vendor/app/electron/main.js": "" },
    /Excluded donor path present/,
  );
  expectViolation({ "x/preload.js": "" }, /Excluded donor path present/);
  expectViolation(
    { "a/browser_emulation/tls.rs": "" },
    /Excluded donor path present/,
  );
  expectViolation(
    { "src/donors/x/unrecorded.ts": "" },
    /Unrecorded file in donor root/,
  );
  expectViolation(
    { "server/run.ts": 'import { spawn } from "node:child_process";' },
    /outside the allowlist/,
  );
  expectViolation(
    { "sdk/x.ts": 'const cp = await import("child_process");' },
    /outside the allowlist/,
  );
  expectViolation(
    { "core/process/owner.ts": "exec(`ffmpeg ${x}`)" },
    /shell-interpreting exec/,
  );
  expectViolation(
    { "core/render.ts": "spawn(f, a, { shell: true })" },
    /shell option/,
  );
  expectViolation({ "src/x.tsx": "eval(code)" }, /dynamic code evaluation/);
  expectViolation(
    { "mcp/x.ts": "new Function(body)" },
    /dynamic code evaluation/,
  );
  expectViolation({}, /Excluded donor path in ledger/, [
    entry,
    { ...entry, original: "electron/main.js", imported: "src/donors/x/a.ts" },
  ]);
  expectViolation({}, /missing sha256/, [
    { ...entry, sha256: undefined } as never,
  ]);
  expectViolation({}, /missing file/, [
    entry,
    { ...entry, imported: "src/donors/x/gone.ts" },
  ]);
  // Bypass attempts reported by the independent T1 reviews.
  const bypasses: Record<string, string> = {
    "core/process/owner.ts":
      'import * as cp from "node:child_process"; cp.execSync(`ffmpeg ${x}`);',
    "core/render.ts": 'import { exec } from "node:child_process";',
    "server/a.ts": 'createRequire(import.meta.url)("child_process")',
    "server/b.ts": 'require ("child_process")',
    "server/c.ts": 'process.getBuiltinModule("node:child_process")',
    "server/d.ts": 'process.binding("spawn_sync")',
    "server/e.ts": 'import "node:child_process";',
    "server/f.ts": 'await import("child_" + "process")',
    "server/g.ts": "await import(`child_process`)",
    "server/h.ts": 'spawn(f, a, { "shell": true })',
    "server/i.ts": "Function('return 1')()",
    "server/j.ts": "globalThis.eval('1')",
    "server/k.ts": 'import vm from "node:vm";',
    "server/l.ts": 'new Worker(src, { eval: true }); import "worker_threads";',
    "server/m.ts": "require(name)",
    "server/n.ts": "(0, eval)('1')",
  };
  for (const [file, text] of Object.entries(bypasses))
    assert.ok(
      run({ ...clean, [file]: text }).some((v) => v.endsWith(file)),
      `guard missed ${file}: ${text}`,
    );
  assert.ok(
    run({
      ...clean,
      "core/render.ts":
        'import { spawn } from "node:child_process";\noptions.shell = true;',
    }).some((v) => /Shell reference/.test(v)),
  );
  assert.deepEqual(
    run({
      ...clean,
      "core/render.ts":
        'import {\n  spawn,\n  execFile,\n} from "node:child_process";\nimport type { ChildProcess } from "node:child_process";\nconst m = /x/.exec(line);',
      "server/ok.ts": 'const { readFile } = await import("node:fs/promises");',
    }),
    [],
    "named spawn import, RegExp#exec and literal dynamic imports are allowed",
  );
  assert.deepEqual(
    run({
      ...clean,
      "tests/a.test.ts": "exec('x')",
      "scripts/b.mjs": "eval(1)",
    }),
    [],
    "tests and scripts are outside production roots",
  );
});
