import { z } from "zod";
import { ProjectSchema, Id } from "../project.ts";
import { BatchSchema } from "../timeline/operations.ts";
import { SNAPSHOT_FORMAT } from "../store.ts";
import type { ProjectStore, RequestReceipt } from "../store.ts";
import { canonicalJson, sha256Hex } from "../donors/ninerr/canonical.ts";
import type { JobSupervisor } from "../jobs.ts";
import { CommandError } from "./errors.ts";
import { RESOURCE_POLICY } from "./policy.ts";
import {
  BackupId,
  backupWorkspace,
  defaultRecoveryHome,
  listBackups,
  restoreFromHome,
} from "../recovery.ts";

export const RESOURCE_POLICY_HASH = sha256Hex(canonicalJson(RESOURCE_POLICY));

export const API_VERSION = 1;

export const Scopes = [
  "project:read",
  "project:write",
  "project:recover",
  "render:execute",
  "job:read",
  "job:control",
] as const;
export type Scope = (typeof Scopes)[number];

// Principals are derived from the authenticated transport, never from the request.
export type Principal = {
  id: "browser-ui" | "local-client";
  scopes: ReadonlySet<Scope>;
};

export type CommandContext = {
  store: ProjectStore;
  queue: JobSupervisor;
  principal: Principal;
  requestId?: string;
  // Where backups and restored roots go: chosen by the service, never by a
  // request (default: a "-recovery" folder beside the workspace).
  recoveryHome?: string;
};
type RunContext = CommandContext & { receipt?: RequestReceipt };

type Definition<S extends z.ZodType, R> = {
  scope: Scope;
  mutation: boolean;
  summary: string;
  input: S;
  run: (ctx: RunContext, input: z.output<S>) => Promise<R> | R;
};
const define = <S extends z.ZodType, R>(d: Definition<S, R>) => d;

const home = (ctx: CommandContext) =>
  ctx.recoveryHome ?? defaultRecoveryHome(ctx.store.root);

const revisionFingerprint = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();

// Every parameter is a strict, bounded schema. No command accepts executable
// text, filtergraphs, shell arguments or host filesystem paths.
export const commands = {
  "yamakan.project.create": define({
    scope: "project:write",
    mutation: true,
    summary: "Create an empty project.",
    input: z.object({ name: z.string().min(1).max(120) }).strict(),
    run: ({ store, receipt }, a) => store.create(a.name, receipt),
  }),
  "yamakan.project.open": define({
    scope: "project:read",
    mutation: false,
    summary: "Read the current head of a project.",
    input: z.object({ projectId: Id }).strict(),
    run: ({ store }, a) => store.load(a.projectId),
  }),
  "yamakan.project.list": define({
    scope: "project:read",
    mutation: false,
    summary: "List projects in the workspace.",
    input: z.object({}).strict(),
    run: ({ store }) => store.list(),
  }),
  "yamakan.project.export": define({
    scope: "project:read",
    mutation: false,
    summary:
      "Export the current revision as canonical project JSON (no host paths or credentials).",
    input: z.object({ projectId: Id }).strict(),
    run: ({ store }, a) => store.exportProject(a.projectId),
  }),
  "yamakan.project.history": define({
    scope: "project:read",
    mutation: false,
    summary: "List the newest retained revisions and verify them.",
    input: z
      .object({
        projectId: Id,
        limit: z.number().int().min(1).max(500).optional(),
        // Page older revisions: list only revisions below this one.
        beforeRevision: z.number().int().min(1).max(10001).optional(),
      })
      .strict(),
    run: ({ store }, a) =>
      store.history(a.projectId, a.limit, a.beforeRevision),
  }),
  "yamakan.project.restore": define({
    scope: "project:recover",
    mutation: true,
    summary: "Restore an older revision as a new head revision.",
    input: z
      .object({
        projectId: Id,
        revision: z.number().int().min(0).max(10000),
        expectedHeadFingerprint: revisionFingerprint,
      })
      .strict(),
    run: ({ store, receipt }, a) =>
      store.restore(
        a.projectId,
        a.revision,
        a.expectedHeadFingerprint,
        receipt,
      ),
  }),
  "yamakan.project.applyBatch": define({
    scope: "project:write",
    mutation: true,
    summary:
      "Apply up to 64 typed timeline operations atomically as one revision.",
    input: z
      .object({
        projectId: Id,
        expectedRevision: z.number().int().nonnegative(),
        operations: BatchSchema,
      })
      .strict(),
    run: ({ store, receipt, principal }, a) =>
      store.applyOperations(
        a.projectId,
        a.expectedRevision,
        a.operations,
        principal.id,
        receipt,
      ),
  }),
  "yamakan.project.undo": define({
    scope: "project:write",
    mutation: true,
    summary:
      "Undo the last applied batch as a new revision (only from the head it produced).",
    input: z
      .object({
        projectId: Id,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    run: ({ store, receipt, principal }, a) =>
      store.undo(a.projectId, a.expectedRevision, principal.id, receipt),
  }),
  "yamakan.project.redo": define({
    scope: "project:write",
    mutation: true,
    summary: "Redo the last undone batch as a new revision.",
    input: z
      .object({
        projectId: Id,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    run: ({ store, receipt, principal }, a) =>
      store.redo(a.projectId, a.expectedRevision, principal.id, receipt),
  }),
  "yamakan.project.save": define({
    scope: "project:write",
    mutation: true,
    summary: "Commit a complete project snapshot at an expected revision.",
    input: z
      .object({
        project: ProjectSchema,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    run: ({ store, receipt }, a) =>
      store.save(a.project, a.expectedRevision, receipt),
  }),
  "yamakan.workspace.backup": define({
    scope: "project:recover",
    mutation: true,
    summary:
      "Back up the workspace (database and verified media) into the service's recovery folder while work continues.",
    input: z.object({}).strict(),
    run: (ctx) => backupWorkspace(ctx.store, home(ctx)),
  }),
  "yamakan.workspace.backups": define({
    scope: "project:read",
    mutation: false,
    summary: "List workspace backups, newest first.",
    input: z.object({}).strict(),
    run: (ctx) => listBackups(home(ctx)),
  }),
  "yamakan.workspace.restore": define({
    scope: "project:recover",
    mutation: true,
    summary:
      "Restore a backup into a new workspace folder (the current workspace is not changed).",
    input: z.object({ backupId: BackupId }).strict(),
    run: (ctx, a) =>
      restoreFromHome(home(ctx), a.backupId, {
        reservedBytes: ctx.store.reservedBytes,
      }),
  }),
  "yamakan.workspace.collectGarbage": define({
    scope: "project:recover",
    mutation: true,
    summary:
      "Remove crash leftovers older than an hour (unregistered media objects, temporary and staging files).",
    input: z.object({}).strict(),
    run: ({ store }) => store.collectGarbage(),
  }),
  "yamakan.export.video": define({
    scope: "render:execute",
    mutation: true,
    summary: "Queue an MP4 export of the current project revision.",
    input: z
      .object({ projectId: Id, idempotencyKey: z.string().min(1).max(80) })
      .strict(),
    run: ({ queue }, a) => queue.submit(a.projectId, a.idempotencyKey),
  }),
  "yamakan.job.status": define({
    scope: "job:read",
    mutation: false,
    summary: "Read a render job.",
    input: z.object({ jobId: Id }).strict(),
    run: ({ queue }, a) => queue.status(a.jobId),
  }),
  "yamakan.job.cancel": define({
    scope: "job:control",
    mutation: true,
    summary: "Request cancellation of a render job.",
    input: z.object({ jobId: Id }).strict(),
    run: ({ queue }, a) => queue.cancel(a.jobId),
  }),
  "yamakan.job.list": define({
    scope: "job:read",
    mutation: false,
    summary: "List render jobs of this service session.",
    input: z.object({}).strict(),
    run: ({ queue }) => queue.list(),
  }),
};

export type Operation = keyof typeof commands;
export type OperationInput<O extends Operation> = z.input<
  (typeof commands)[O]["input"]
>;
export type OperationResult<O extends Operation> = Awaited<
  ReturnType<(typeof commands)[O]["run"]>
>;

// Pre-Yamakan clients used the darzain.* names; they remain accepted aliases.
const LEGACY_PREFIX = "darzain.";
export function resolveOperation(name: unknown): Operation {
  if (typeof name !== "string" || name.length > 80)
    throw new CommandError("VALIDATION", "Unknown operation.");
  const canonical = name.startsWith(LEGACY_PREFIX)
    ? `yamakan.${name.slice(LEGACY_PREFIX.length)}`
    : name;
  if (!Object.hasOwn(commands, canonical))
    throw new CommandError("VALIDATION", "Unknown operation.");
  return canonical as Operation;
}

export function authorize(principal: Principal, operation: Operation) {
  const { scope } = commands[operation];
  if (!principal.scopes.has(scope))
    throw new CommandError(
      "SCOPE_DENIED",
      `Principal ${principal.id} lacks scope ${scope}.`,
    );
}

export async function execute(
  ctx: CommandContext,
  name: unknown,
  parameters: unknown,
) {
  const operation = resolveOperation(name);
  authorize(ctx.principal, operation);
  const command = commands[operation] as Definition<z.ZodType, unknown>;
  const input = command.input.parse(parameters ?? {});
  // A mutation with a request ID is replayable: the same ID and input return
  // the original result; the same ID with different input is rejected.
  const receipt =
    command.mutation && ctx.requestId
      ? {
          principalId: ctx.principal.id,
          requestId: ctx.requestId,
          digest: sha256Hex(
            canonicalJson({
              apiVersion: API_VERSION,
              format: SNAPSHOT_FORMAT,
              operation,
              input,
            }),
          ),
        }
      : undefined;
  return { operation, result: await command.run({ ...ctx, receipt }, input) };
}

export function catalog() {
  return Object.entries(commands).map(([name, c]) => ({
    name,
    scope: c.scope,
    mutation: c.mutation,
    summary: c.summary,
    legacyAlias: name.replace(/^yamakan\./, LEGACY_PREFIX),
    inputSchema: z.toJSONSchema(c.input),
  }));
}
