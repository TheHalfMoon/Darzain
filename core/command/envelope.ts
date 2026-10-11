import { randomUUID } from "node:crypto";
import { z } from "zod";
import { API_VERSION } from "./registry.ts";
import { CommandError } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";

export const RequestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const EnvelopeSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    operation: z.string().min(1).max(80),
    requestId: RequestId.optional(),
    parameters: z.unknown().optional(),
  })
  .strict();

// The pre-envelope body `{ name, arguments }` is still accepted for older clients.
const LegacySchema = z
  .object({
    name: z.string().min(1).max(80),
    arguments: z.unknown().optional(),
  })
  .strict();

export type CommandRequest = {
  operation: string;
  requestId: string;
  // Only client-supplied IDs are replayable; generated ones only trace the call.
  clientRequestId: boolean;
  parameters: unknown;
};

export function parseEnvelope(body: unknown): CommandRequest {
  if (typeof body === "object" && body !== null && "apiVersion" in body) {
    const e = EnvelopeSchema.safeParse(body);
    if (!e.success)
      throw new CommandError("VALIDATION", "Invalid command envelope.");
    return {
      operation: e.data.operation,
      requestId: e.data.requestId ?? randomUUID(),
      clientRequestId: e.data.requestId !== undefined,
      parameters: e.data.parameters ?? {},
    };
  }
  const legacy = LegacySchema.safeParse(body);
  if (!legacy.success)
    throw new CommandError("VALIDATION", "Invalid command envelope.");
  return {
    operation: legacy.data.name,
    requestId: randomUUID(),
    clientRequestId: false,
    parameters: legacy.data.arguments ?? {},
  };
}

export type CommandSuccess<R = unknown> = {
  apiVersion: typeof API_VERSION;
  requestId: string;
  operation: string;
  result: R;
};
export type CommandFailure = {
  apiVersion: typeof API_VERSION;
  requestId: string;
  error: { code: ErrorCode; message: string; retryable: boolean };
};
