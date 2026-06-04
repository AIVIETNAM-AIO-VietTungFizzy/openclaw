import { PaperclipClient, createPaperclipClient } from "./client.js";
import type { PaperclipClientConfig } from "./client.js";
import {
  InMemoryIdempotencyStore,
  computeRequestHash,
  type IdempotencyStore,
} from "./idempotency.js";
import { getOperation, isKnownOperation, isMutation, requiresIdempotencyKey } from "./registry.js";
import { executeWithRetry, type RetryableError, type ExecuteWithRetryOptions } from "./retry.js";
import { ContractEnvelopeSchema, ErrorCategory, RiskLevel } from "./types.js";
import type { ContractEnvelope, SuccessResponse, ErrorResponse } from "./types.js";

const SUPPORTED_VERSION = "2026-05-28";

export interface FacadeConfig {
  paperclip: PaperclipClientConfig;
  contractVersion?: string;
  /** Identifies the target environment for the request hash. Defaults to the client base URL host. */
  targetEnv?: string;
  /** Override the idempotency store (defaults to an in-memory store). */
  store?: IdempotencyStore;
  /** Injectable backoff sleep (tests pass a no-op to avoid real waits). */
  sleep?: ExecuteWithRetryOptions["sleep"];
}

export interface FacadeDeps {
  client: PaperclipClient;
  store: IdempotencyStore;
  targetEnv: string;
  /** Injectable backoff sleep (tests pass a no-op). */
  sleep?: ExecuteWithRetryOptions["sleep"];
}

export interface ExecuteResult {
  success: boolean;
  response: SuccessResponse | ErrorResponse;
}

export async function paperclipContractCall(
  envelope: unknown,
  deps: FacadeDeps,
): Promise<ExecuteResult> {
  // 1. Validate envelope
  const parsed = ContractEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return makeError("INVALID_REQUEST", ErrorCategory.SCHEMA, false, "Malformed contract envelope");
  }

  const env = parsed.data;

  // 2. Check contract version
  if (env.contractVersion !== SUPPORTED_VERSION) {
    return makeError(
      "CONTRACT_VERSION_UNSUPPORTED",
      ErrorCategory.SCHEMA,
      false,
      `Unsupported contract version '${env.contractVersion}'`,
      1,
      env,
    );
  }

  // 3. Classify risk via registry
  if (!isKnownOperation(env.operation)) {
    return makeError(
      "UNKNOWN_OPERATION",
      ErrorCategory.POLICY,
      false,
      `Unknown operation '${env.operation}'`,
      1,
      env,
    );
  }

  const entry = getOperation(env.operation);
  const risk = entry?.risk ?? RiskLevel.FORBIDDEN;

  if (risk === RiskLevel.FORBIDDEN) {
    return makeError(
      "POLICY_DENIED",
      ErrorCategory.POLICY,
      false,
      `Operation '${env.operation}' is forbidden`,
      1,
      env,
    );
  }

  // 4. Check idempotency key requirement
  if (requiresIdempotencyKey(env.operation) && !env.idempotencyKey) {
    return makeError(
      "IDEMPOTENCY_KEY_REQUIRED",
      ErrorCategory.IDEMPOTENCY,
      false,
      `Mutation '${env.operation}' requires idempotencyKey`,
      1,
      env,
    );
  }

  const mutation = isMutation(env.operation);
  const isReadOnly = !mutation;

  // 5. Idempotency store: lookup → replay / conflict / pending / unknown (mutations with a key only)
  const key = mutation ? (env.idempotencyKey ?? null) : null;
  if (key) {
    const requestHash = computeRequestHash(env, deps.targetEnv);
    const existing = await deps.store.get(key);
    if (existing) {
      // Rule 3: same key, different payload → conflict (regardless of status).
      if (existing.requestHash !== requestHash) {
        return makeError(
          "IDEMPOTENCY_CONFLICT",
          ErrorCategory.IDEMPOTENCY,
          false,
          `idempotencyKey '${key}' reused with a different request`,
          1,
          env,
        );
      }
      // Rule 2: completed + same hash → replay stored response.
      if (existing.status === "completed") {
        return { success: true, response: existing.responseBody as SuccessResponse };
      }
      // Rule 4: still in flight → pending marker.
      if (existing.status === "pending") {
        return makePending(env, key);
      }
      // Rule 5: corrupted/unknown → manual review.
      if (existing.status === "unknown") {
        return makeError(
          "UNKNOWN_STATE",
          ErrorCategory.EXECUTION,
          false,
          `idempotencyKey '${key}' is in an unknown state; manual review required`,
          1,
          env,
        );
      }
      // status === "failed" + same hash → fall through and re-execute.
    }
    await deps.store.putPending({
      idempotencyKey: key,
      operation: env.operation,
      requestHash,
    });
  }

  // 6. Execute the operation with retry
  try {
    const { result, attempts } = await executeWithRetry(() => callOperation(deps.client, env), {
      operation: env.operation,
      idempotencyKey: env.idempotencyKey,
      isReadOnly,
      sleep: deps.sleep,
    });

    const response = buildSuccess(env, result, attempts);
    if (key) await deps.store.complete(key, response);
    return { success: true, response };
  } catch (err: unknown) {
    if (key) await deps.store.fail(key);
    const e = (err ?? {}) as RetryableError;
    if (typeof e.code === "string") {
      return makeError(
        e.code,
        (e.category as ErrorCategory) ?? ErrorCategory.INTERNAL,
        Boolean(e.retryable),
        e.message ?? e.code,
        e.attempt ?? 1,
        env,
      );
    }
    return makeError("UNKNOWN_ERROR", ErrorCategory.INTERNAL, false, String(err), 1, env);
  }
}

function callOperation(client: PaperclipClient, env: ContractEnvelope): Promise<unknown> {
  switch (env.operation) {
    case "paperclip.ready_work":
      return client.ready_work(env);
    case "paperclip.work_item_detail":
      return client.work_item_detail(env);
    case "paperclip.raise_blocker":
      return client.raise_blocker(env);
    case "paperclip.complete_work_item":
      return client.complete_work_item(env);
    default: {
      const e = new Error(`Unhandled known operation '${env.operation}'`) as Error & {
        code: string;
        category: string;
        retryable: boolean;
      };
      e.code = "UNKNOWN_OPERATION";
      e.category = ErrorCategory.POLICY;
      e.retryable = false;
      return Promise.reject(e);
    }
  }
}

function buildSuccess(env: ContractEnvelope, result: unknown, attempt: number): SuccessResponse {
  return {
    ok: true,
    contractVersion: env.contractVersion,
    requestId: env.requestId,
    idempotencyKey: env.idempotencyKey,
    operation: env.operation,
    result,
    meta: {
      attempt,
      retryable: false,
      approved: false,
    },
  };
}

/** Rule 4: an in-flight request with the same key. Surfaced as a retryable pending marker. */
function makePending(env: ContractEnvelope, key: string): ExecuteResult {
  const response: SuccessResponse = {
    ok: true,
    contractVersion: env.contractVersion,
    requestId: env.requestId,
    idempotencyKey: key,
    operation: env.operation,
    result: { status: "pending", idempotencyKey: key },
    meta: {
      attempt: 1,
      retryable: true,
      approved: false,
    },
  };
  return { success: true, response };
}

function makeError(
  code: string,
  category: ErrorCategory,
  retryable: boolean,
  message: string,
  attempt = 1,
  env?: ContractEnvelope,
): ExecuteResult {
  const response: ErrorResponse = {
    ok: false,
    contractVersion: env?.contractVersion ?? SUPPORTED_VERSION,
    requestId: env?.requestId ?? "unknown",
    operation: env?.operation ?? "unknown",
    error: {
      code,
      category,
      message,
      retryable,
    },
    meta: { attempt, approved: false },
  };
  return { success: false, response };
}

function deriveTargetEnv(config: FacadeConfig): string {
  if (config.targetEnv) return config.targetEnv;
  try {
    return new URL(config.paperclip.baseUrl).host;
  } catch {
    return config.paperclip.baseUrl;
  }
}

export function createFacade(config: FacadeConfig): {
  client: PaperclipClient;
  store: IdempotencyStore;
  call: (envelope: unknown) => Promise<ExecuteResult>;
} {
  const client = createPaperclipClient(config.paperclip);
  const store = config.store ?? new InMemoryIdempotencyStore();
  const targetEnv = deriveTargetEnv(config);
  return {
    client,
    store,
    call: (envelope: unknown) =>
      paperclipContractCall(envelope, { client, store, targetEnv, sleep: config.sleep }),
  };
}
