# Idempotency Policy — Paperclip ↔ OpenClaw Contract

**Version:** 2026-05-28
**Contract:** `PAPERCLIP_OPENCLAW_CONTRACT`

---

## Rule 0: No idempotency key → no mutation retry

Only mutation operations (`mutation: true` in the operation registry) require an idempotency key. Read-only operations (`mutation: false`) do not need one and are never idempotent-key-gated.

---

## Rule 1: Mutations require an idempotency key

Any operation where `requiresIdempotencyKey: true` in the registry MUST include `idempotencyKey` in the request envelope. If absent, the contract returns `IDEMPOTENCY_KEY_REQUIRED` before any network call.

---

## Rule 2: Same key + same request hash → return stored response

The idempotency store computes a request hash:

```
requestHash = sha256(contractVersion + operation + normalizedParams + targetEnv)
```

Normalization excludes:

- Timestamps (`createdAt`, `updatedAt`, `queuedAt`)
- Volatile fields that change between calls without semantic difference

If `idempotencyKey` matches a prior entry AND `requestHash` matches the stored hash → return the stored response immediately. This is safe retry.

---

## Rule 3: Same key + different request hash → IDEMPOTENCY_CONFLICT

If the same `idempotencyKey` is reused but the request body hash differs, the contract MUST return `IDEMPOTENCY_CONFLICT`. The client must not retry; the operation is ambiguous.

---

## Rule 4: Pending state → wait or return pending marker

If a prior request with the same key is still `pending` (started but not completed), the new request returns a response indicating `status: "pending"` with the original `requestId`. The client may poll or wait.

---

## Rule 5: Unknown completion state → UNKNOWN_STATE

If the idempotency store entry exists but its status is neither `pending` nor `completed` nor `failed` (e.g., orphaned/corrupted), return `UNKNOWN_STATE` requiring manual review.

---

## Rule 6: Expiry

Idempotency store entries expire after 24 hours (configurable). Expired entries are treated as not found — new requests proceed normally.

---

## Store schema (SQLite reference impl)

```sql
CREATE TABLE idempotency_store (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','completed','failed','unknown')),
  response_body   TEXT,           -- JSON serialized response
  created_at      TEXT NOT NULL,  -- ISO 8601
  updated_at      TEXT NOT NULL,  -- ISO 8601
  expires_at      TEXT NOT NULL   -- ISO 8601
);
```

Indexes:

- `idx_idempotency_status` on `(status)` for pending scans
- `idx_idempotency_expires` on `(expires_at)` for cleanup

---

## Non-goals

- The idempotency store does not guarantee exactly-once execution across distributed nodes — it guarantees at-least-once with deduplication per Paperclip 4B server instance.
- Long-running operations (async approvals) are not handled here — they are tracked by the approval flow, not the idempotency store.
