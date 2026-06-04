import axios, { type AxiosInstance } from "axios";
import { getHttpVerb, getHttpPath } from "./registry.js";
import type { ContractEnvelope } from "./types.js";

export interface PaperclipClientConfig {
  baseUrl: string;
  timeout?: number;
  /**
   * Bearer token for the real Paperclip `/api` (the agent JWT). When set it is
   * sent as `Authorization: Bearer <token>`. The live Paperclip runs in
   * "authenticated" mode, so agent endpoints 401 without it.
   */
  authToken?: string;
}

const DEFAULT_TIMEOUT = 15_000;

export class PaperclipClient {
  private readonly client: AxiosInstance;

  constructor(private readonly config: PaperclipClientConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      headers: { "Content-Type": "application/json" },
    });
  }

  async ready_work(envelope: ContractEnvelope): Promise<unknown> {
    return this.execute(envelope, "paperclip.ready_work");
  }

  async work_item_detail(envelope: ContractEnvelope): Promise<unknown> {
    return this.execute(envelope, "paperclip.work_item_detail");
  }

  async raise_blocker(envelope: ContractEnvelope): Promise<unknown> {
    return this.execute(envelope, "paperclip.raise_blocker");
  }

  async complete_work_item(envelope: ContractEnvelope): Promise<unknown> {
    return this.execute(envelope, "paperclip.complete_work_item");
  }

  private async execute(envelope: ContractEnvelope, operation: string): Promise<unknown> {
    const verb = getHttpVerb(operation);
    const pathTemplate = getHttpPath(operation);

    if (!verb || !pathTemplate) {
      throw new Error(`UNKNOWN_OPERATION: no HTTP mapping for '${operation}'`);
    }

    const path = substitutePath(pathTemplate, envelope);

    const headers: Record<string, string> = {
      "X-Trace-Id": envelope.traceId,
      "X-Request-Id": envelope.requestId,
    };

    if (this.config.authToken) {
      headers["Authorization"] = `Bearer ${this.config.authToken}`;
    }

    if (envelope.idempotencyKey) {
      headers["X-Idempotency-Key"] = envelope.idempotencyKey;
    }

    try {
      let response;
      if (verb === "GET") {
        response = await this.client.get(path, { headers });
      } else if (verb === "POST") {
        response = await this.client.post(path, envelope.params, { headers });
      } else if (verb === "PATCH") {
        response = await this.client.patch(path, envelope.params, { headers });
      } else if (verb === "DELETE") {
        response = await this.client.delete(path, { headers });
      } else {
        throw new Error(`UNKNOWN_OPERATION: unsupported HTTP verb '${verb}' of '${operation}'`);
      }
      return response.data;
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        "isAxiosError" in err &&
        (err as Record<string, unknown>).isAxiosError === true
      ) {
        const axiosErr = err as {
          response?: { status?: number; headers?: Record<string, unknown> };
          code?: string;
          message?: string;
        };
        const status = axiosErr.response?.status;

        if (status === 400) {
          // Real Paperclip returns 400 for malformed/misscoped requests
          // (e.g. "Missing companyId in path").
          throw makeError("INVALID_REQUEST", "SCHEMA", false, "INVALID_REQUEST");
        }
        if (status === 401 || status === 403) {
          // "Agent authentication required" / "Board access required".
          throw makeError("POLICY_DENIED", "POLICY", false, "POLICY_DENIED");
        }
        if (status === 404) {
          throw makeError("WORK_ITEM_NOT_FOUND", "UPSTREAM", false, "WORK_ITEM_NOT_FOUND");
        }
        if (status === 409) {
          throw makeError("IDEMPOTENCY_CONFLICT", "IDEMPOTENCY", false, "IDEMPOTENCY_CONFLICT");
        }
        if (status === 429) {
          const retryAfterMs = parseRetryAfter(axiosErr.response?.headers);
          throw makeError("RATE_LIMITED", "UPSTREAM", true, "RATE_LIMITED", retryAfterMs);
        }
        if (status === 503) {
          throw makeError("UPSTREAM_UNAVAILABLE", "UPSTREAM", true, "UPSTREAM_UNAVAILABLE");
        }
        if (status === 0 || status === undefined) {
          const code = axiosErr.code ?? "";
          if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
            throw makeError("TIMEOUT", "UPSTREAM", true, "TIMEOUT");
          }
          throw makeError("UPSTREAM_UNAVAILABLE", "UPSTREAM", true, "UPSTREAM_UNAVAILABLE");
        }
        if (status && status >= 500) {
          // 5xx is UPSTREAM_FAILED — NOT retryable per the taxonomy + retry-policy.
          throw makeError("UPSTREAM_FAILED", "UPSTREAM", false, "UPSTREAM_FAILED");
        }
      }
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get("/api/health", { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }
}

function substitutePath(template: string, envelope: ContractEnvelope): string {
  // Path params resolve from envelope.params first, then from the caller identity
  // (e.g. `:companyId`/`:agentId` for company- and agent-scoped Paperclip routes).
  const caller = (envelope.caller ?? {}) as Record<string, unknown>;
  const subs: Record<string, unknown> = {
    companyId: caller.companyId,
    agentId: caller.agentId,
    employeeId: caller.employeeId,
    ...envelope.params,
  };
  let path = template;
  for (const [key, value] of Object.entries(subs)) {
    if (typeof value === "string" || typeof value === "number") {
      path = path.replace(`:${key}`, String(value));
    }
  }
  return path;
}

function makeError(
  code: string,
  category: string,
  retryable: boolean,
  message: string,
  retryAfterMs?: number,
): Error & { code: string; category: string; retryable: boolean; retryAfterMs?: number } {
  const e = new Error(message) as Error & {
    code: string;
    category: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  e.code = code;
  e.category = category;
  e.retryable = retryable;
  if (typeof retryAfterMs === "number") e.retryAfterMs = retryAfterMs;
  return e;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(headers?: Record<string, unknown>): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

export function createPaperclipClient(config: PaperclipClientConfig): PaperclipClient {
  return new PaperclipClient(config);
}
