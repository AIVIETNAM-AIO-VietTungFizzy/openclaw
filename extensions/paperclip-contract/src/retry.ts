// Static import: inlined by the bundler (no runtime fs read in the image).
import retryPolicyData from "../contracts/paperclip-openclaw-retry-policy.v1.json" with { type: "json" };

const BACKOFF_CAP_MS = 10_000;
const JITTER_MS = 200;

export interface RetryMatrixEntry {
  retryable: boolean;
  maxAttempts: number;
  respectRetryAfter?: boolean;
  backoffMs?: number[];
  requiresIdempotencyKey?: boolean;
  notes?: string;
}

let _matrix: Record<string, RetryMatrixEntry> | null = null;

export function loadRetryMatrix(): Record<string, RetryMatrixEntry> {
  if (_matrix) return _matrix;
  const parsed = retryPolicyData as { retryMatrix?: Record<string, RetryMatrixEntry> };
  _matrix = parsed.retryMatrix ?? {};
  return _matrix;
}

export function getRetryPolicy(code: string): RetryMatrixEntry | undefined {
  return loadRetryMatrix()[code];
}

// ─── Retryable error shape ────────────────────────────────────────────────────

/** Errors thrown by the PaperclipClient carry these fields. */
export interface RetryableError {
  code?: string;
  category?: string;
  retryable?: boolean;
  message?: string;
  /** Parsed from an upstream Retry-After header (ms), when present. */
  retryAfterMs?: number;
  /** Stamped by executeWithRetry so the facade can surface meta.attempt. */
  attempt?: number;
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export interface ExecuteWithRetryOptions {
  operation: string;
  idempotencyKey?: string | null;
  /** Read-only operations are safe to retry even without an idempotency key. */
  isReadOnly: boolean;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryOutcome<T> {
  result: T;
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Execute `fn`, retrying per the frozen retry-policy matrix. Retry decisions are
 * driven entirely by the thrown error's taxonomy `code` — never by the agent and
 * never by the client's own `retryable` flag (which resolves the UPSTREAM_FAILED
 * inconsistency). Returns the result plus the number of attempts made.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  opts: ExecuteWithRetryOptions,
): Promise<RetryOutcome<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 1;

  for (;;) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err: unknown) {
      const e = (err ?? {}) as RetryableError;
      const policy = e.code ? getRetryPolicy(e.code) : undefined;

      if (!shouldRetry(policy, attempt, opts)) {
        if (e && typeof e === "object") e.attempt = attempt;
        throw err;
      }

      await sleep(computeBackoffMs(policy as RetryMatrixEntry, attempt, e.retryAfterMs));
      attempt += 1;
    }
  }
}

/**
 * Retry gating (all must hold):
 *  1. the error code is retryable in the matrix,
 *  2. we have attempts left,
 *  3. the op is read-only OR an idempotency key is present,
 *  4. if the matrix entry requires an idempotency key, one is present.
 */
export function shouldRetry(
  policy: RetryMatrixEntry | undefined,
  attempt: number,
  opts: Pick<ExecuteWithRetryOptions, "idempotencyKey" | "isReadOnly">,
): boolean {
  if (!policy || !policy.retryable) return false;
  if (attempt >= policy.maxAttempts) return false;
  const hasKey = Boolean(opts.idempotencyKey);
  if (!opts.isReadOnly && !hasKey) return false;
  if (policy.requiresIdempotencyKey && !hasKey) return false;
  return true;
}

/**
 * Backoff for the upcoming attempt. Prefer an upstream Retry-After when the
 * matrix opts into it; otherwise use the per-code backoff window plus jitter,
 * capped at 10s.
 */
export function computeBackoffMs(
  policy: RetryMatrixEntry,
  attempt: number,
  retryAfterMs?: number,
): number {
  if (policy.respectRetryAfter && typeof retryAfterMs === "number") {
    return Math.min(retryAfterMs, BACKOFF_CAP_MS);
  }
  const arr = policy.backoffMs ?? [];
  const base = arr.length > 0 ? arr[Math.min(attempt - 1, arr.length - 1)] : 1000;
  const jitter = Math.random() * JITTER_MS;
  return Math.min(base + jitter, BACKOFF_CAP_MS);
}
