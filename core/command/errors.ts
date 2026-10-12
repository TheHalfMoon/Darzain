import { ZodError } from "zod";

export const ErrorCodes = [
  "VALIDATION",
  "UNAUTHENTICATED",
  "FORBIDDEN_ORIGIN",
  "SCOPE_DENIED",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_MISMATCH",
  "BUSY",
  "LIMIT_EXCEEDED",
  "MEDIA_INVALID",
  "RECOVERY_REQUIRED",
  "CAPABILITY_UNAVAILABLE",
  "UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

const retryable: Record<ErrorCode, boolean> = {
  VALIDATION: false,
  UNAUTHENTICATED: false,
  FORBIDDEN_ORIGIN: false,
  SCOPE_DENIED: false,
  NOT_FOUND: false,
  REVISION_CONFLICT: false,
  IDEMPOTENCY_MISMATCH: false,
  BUSY: true,
  LIMIT_EXCEEDED: false,
  MEDIA_INVALID: false,
  RECOVERY_REQUIRED: false,
  CAPABILITY_UNAVAILABLE: false,
  UNAVAILABLE: true,
  INTERNAL: false,
};

export const httpStatus: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  SCOPE_DENIED: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  BUSY: 503,
  LIMIT_EXCEEDED: 413,
  MEDIA_INVALID: 422,
  RECOVERY_REQUIRED: 409,
  CAPABILITY_UNAVAILABLE: 501,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  // `options.cause` keeps a server-side cause behind a fixed public message.
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandError";
    this.code = code;
    this.retryable = retryable[code];
  }
}

// Existing core modules throw plain errors with stable messages; classify them
// so every transport reports the same code. Unrecognized failures are INTERNAL.
const classified: [RegExp, ErrorCode][] = [
  [/^Revision conflict/, "REVISION_CONFLICT"],
  [/changed during (reading|preservation)|fingerprint time limit/, "BUSY"],
  [/not found\.$/i, "NOT_FOUND"],
  [
    /integrity check failed|hash mismatch|identity mismatch/i,
    "RECOVERY_REQUIRED",
  ],
  [
    /limit (reached|exceeded)|exceeds (its|a|ten)|size exceeds/i,
    "LIMIT_EXCEEDED",
  ],
  [/Insufficient free disk space/, "LIMIT_EXCEEDED"],
  [/^Media |media streams|Media signature/, "MEDIA_INVALID"],
  [/^Render queue is closing.$|^Server is shutting down.$/, "UNAVAILABLE"],
  [
    /^Path escapes|Symbolic links|Invalid idempotency|Unknown tool|must be added|no active picture|Artifact is not complete/,
    "VALIDATION",
  ],
  [/No local title font/, "CAPABILITY_UNAVAILABLE"],
];

export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof ZodError)
    return new CommandError(
      "VALIDATION",
      error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; "),
    );
  if (error instanceof URIError)
    return new CommandError("VALIDATION", "Malformed percent-encoding.");
  if (error instanceof SyntaxError)
    return new CommandError("VALIDATION", "Request body is not valid JSON.");
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (errno === "ENOENT")
    return (error as NodeJS.ErrnoException).syscall?.startsWith("spawn")
      ? new CommandError(
          "CAPABILITY_UNAVAILABLE",
          "A required media tool is not installed.",
        )
      : new CommandError("NOT_FOUND", "Resource not found.");
  if (errno === "ENOSPC")
    return new CommandError("LIMIT_EXCEEDED", "Insufficient free disk space.");
  const message = error instanceof Error ? error.message : "Operation failed.";
  for (const [pattern, code] of classified)
    if (pattern.test(message)) return new CommandError(code, message);
  return new CommandError("INTERNAL", message);
}
