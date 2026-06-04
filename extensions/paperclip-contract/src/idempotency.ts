import { createHash } from "crypto";
import type { ContractEnvelope, IdempotencyRecord } from "./types.js";

// ─── Store interface ──────────────────────────────────────────────────────────

/**
 * Durable-store abstraction for idempotency records. The in-memory impl below is
 * the default; a SQLite/Redis impl can be dropped in without touching the facade.
 * Methods are async so a network/DB-backed store fits the same shape.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  putPending(params: {
    idempotencyKey: string;
    operation: string;
    requestHash: string;
  }): Promise<IdempotencyRecord>;
  complete(key: string, responseBody: unknown): Promise<void>;
  fail(key: string): Promise<void>;
  markUnknown(key: string): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InMemoryStoreOptions {
  /** Entry TTL; expired entries are treated as not-found. Default 24h. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: InMemoryStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DAY_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const rec = this.map.get(key);
    if (!rec) return undefined;
    // Rule 6: expired entries are treated as not found.
    if (new Date(rec.expiresAt).getTime() <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return rec;
  }

  async putPending(params: {
    idempotencyKey: string;
    operation: string;
    requestHash: string;
  }): Promise<IdempotencyRecord> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const rec: IdempotencyRecord = {
      idempotencyKey: params.idempotencyKey,
      operation: params.operation,
      requestHash: params.requestHash,
      status: "pending",
      responseBody: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    this.map.set(params.idempotencyKey, rec);
    return rec;
  }

  async complete(key: string, responseBody: unknown): Promise<void> {
    this.transition(key, "completed", responseBody);
  }

  async fail(key: string): Promise<void> {
    this.transition(key, "failed");
  }

  async markUnknown(key: string): Promise<void> {
    this.transition(key, "unknown");
  }

  private transition(
    key: string,
    status: IdempotencyRecord["status"],
    responseBody?: unknown,
  ): void {
    const rec = this.map.get(key);
    if (!rec) return;
    rec.status = status;
    if (responseBody !== undefined) rec.responseBody = responseBody;
    rec.updatedAt = new Date(this.now()).toISOString();
  }
}

// ─── Request hash ─────────────────────────────────────────────────────────────

/** Volatile fields excluded from the request hash (Rule 2). */
const VOLATILE_FIELDS = new Set(["createdAt", "updatedAt", "queuedAt"]);

/**
 * Canonicalize a value: sort object keys, drop volatile fields, recurse. Makes
 * JSON.stringify output stable regardless of key order / volatile timestamps.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (VOLATILE_FIELDS.has(key)) continue;
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * requestHash = sha256(contractVersion + operation + normalizedParams + targetEnv).
 * Stable across param key order and volatile-field changes.
 */
export function computeRequestHash(
  envelope: Pick<ContractEnvelope, "contractVersion" | "operation" | "params">,
  targetEnv: string,
): string {
  const payload = JSON.stringify({
    contractVersion: envelope.contractVersion,
    operation: envelope.operation,
    params: canonicalize(envelope.params ?? {}),
    targetEnv,
  });
  return createHash("sha256").update(payload).digest("hex");
}
