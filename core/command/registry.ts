import { z } from "zod";
import { ProjectSchema, Id } from "../project.ts";
import type { ProjectStore } from "../store.ts";
import type { RenderQueue } from "../render.ts";
import { CommandError } from "./errors.ts";

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
  queue: RenderQueue;
  principal: Principal;
};

type Definition<S extends z.ZodType, R> = {
  scope: Scope;
  mutation: boolean;
  summary: string;
  input: S;
  run: (ctx: CommandContext, input: z.output<S>) => Promise<R> | R;
};
const define = <S extends z.ZodType, R>(d: Definition<S, R>) => d;

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
    run: ({ store }, a) => store.create(a.name),
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
  "yamakan.project.history": define({
    scope: "project:read",
    mutation: false,
    summary: "List retained revisions and verify the head.",
    input: z.object({ projectId: Id }).strict(),
    run: ({ store }, a) => store.history(a.projectId),
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
    run: ({ store }, a) =>
      store.restore(a.projectId, a.revision, a.expectedHeadFingerprint),
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
    run: ({ store }, a) => store.save(a.project, a.expectedRevision),
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
  return { operation, result: await command.run(ctx, input) };
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
