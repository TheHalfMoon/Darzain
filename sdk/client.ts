import type {
  Operation,
  OperationInput,
  OperationResult,
} from "../core/command/registry.ts";
import type { ErrorCode } from "../core/command/errors.ts";

export type { Operation, OperationInput, OperationResult };

export class YamakanError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | null;
  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    requestId: string | null,
  ) {
    super(message);
    this.name = "YamakanError";
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

export type ClientOptions = {
  // Omit in the browser UI: requests go to the page's own origin.
  baseUrl?: string;
  // Local-client bearer credential read from the workspace token file.
  token?: string;
  // Extra headers for each request (the browser UI's session header).
  headers?: () => Record<string, string>;
  fetch?: typeof fetch;
};

// Results cross a JSON boundary, so typed results describe the decoded JSON shape.
export class YamakanClient {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #extra: () => Record<string, string>;
  constructor(options: ClientOptions = {}) {
    this.#base = options.baseUrl?.replace(/\/$/, "") ?? "";
    this.#token = options.token;
    this.#extra = options.headers ?? (() => ({}));
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  #headers(extra: Record<string, string> = {}) {
    const headers = { ...this.#extra(), ...extra };
    return this.#token
      ? { ...headers, Authorization: `Bearer ${this.#token}` }
      : headers;
  }
  async call<O extends Operation>(
    operation: O,
    parameters: OperationInput<O>,
    requestId?: string,
  ): Promise<OperationResult<O>> {
    const response = await this.#fetch(`${this.#base}/api/v1/call`, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        apiVersion: 1,
        operation,
        ...(requestId ? { requestId } : {}),
        parameters,
      }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || "error" in value) {
      const e = value?.error;
      throw new YamakanError(
        e?.code ?? "INTERNAL",
        e?.message ?? `Request failed with HTTP ${response.status}.`,
        Boolean(e?.retryable),
        value?.requestId ?? null,
      );
    }
    return value.result as OperationResult<O>;
  }
  async catalog(): Promise<{
    apiVersion: number;
    service: string;
    tools: {
      name: Operation;
      scope: string;
      mutation: boolean;
      summary: string;
      inputSchema: Record<string, unknown>;
    }[];
  }> {
    const response = await this.#fetch(`${this.#base}/api/v1/tools`, {
      headers: this.#headers(),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) {
      const e = value?.error;
      throw new YamakanError(
        e?.code ?? "INTERNAL",
        e?.message ?? `Catalog request failed with HTTP ${response.status}.`,
        Boolean(e?.retryable),
        value?.requestId ?? null,
      );
    }
    return value;
  }
}
