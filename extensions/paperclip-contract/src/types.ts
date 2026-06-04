import { z } from "zod";

// ─── Contract Envelope ────────────────────────────────────────────────────────

export const CallerSchema = z
  .object({
    agentId: z.string(),
    sessionKey: z.string(),
    tenantId: z.string(),
    companyId: z.string(),
    employeeId: z.string(),
    package: z.enum(["L0", "L1", "L2", "L3"]),
    runtimeLane: z.enum(["7A", "7B", "deer-flow"]),
  })
  .strict();

export type Caller = z.infer<typeof CallerSchema>;

export const ContractEnvelopeSchema = z.object({
  contractVersion: z.string(),
  requestId: z.string(),
  operation: z.string(),
  idempotencyKey: z.string().nullable().optional(),
  traceId: z.string(),
  caller: CallerSchema,
  params: z.record(z.string(), z.unknown()),
});

export type ContractEnvelope = z.infer<typeof ContractEnvelopeSchema>;

// ─── Response Shapes ──────────────────────────────────────────────────────────

export const SuccessResponseMetaSchema = z.object({
  attempt: z.number().min(1),
  retryable: z.boolean(),
  approved: z.boolean(),
  approvalId: z.string().nullable().optional(),
});

export type SuccessResponseMeta = z.infer<typeof SuccessResponseMetaSchema>;

export const SuccessResponseSchema = z.object({
  ok: z.literal(true),
  contractVersion: z.string(),
  requestId: z.string(),
  idempotencyKey: z.string().nullable().optional(),
  operation: z.string(),
  result: z.custom<unknown>((v) => v !== undefined, { message: "result is required" }),
  meta: SuccessResponseMetaSchema,
});

export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

export const ErrorResponseMetaSchema = z.object({
  attempt: z.number(),
  approved: z.boolean(),
});

export type ErrorResponseMeta = z.infer<typeof ErrorResponseMetaSchema>;

export const ErrorDetailSchema = z.object({
  code: z.string(),
  category: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  contractVersion: z.string(),
  requestId: z.string(),
  operation: z.string(),
  error: ErrorDetailSchema,
  meta: ErrorResponseMetaSchema,
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ErrorCode = {
  INVALID_REQUEST: "INVALID_REQUEST",
  CONTRACT_VERSION_UNSUPPORTED: "CONTRACT_VERSION_UNSUPPORTED",
  SCHEMA_VALIDATION_FAILED: "SCHEMA_VALIDATION_FAILED",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  POLICY_DENIED: "POLICY_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_DENIED: "APPROVAL_DENIED",
  APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  WORK_ITEM_NOT_FOUND: "WORK_ITEM_NOT_FOUND",
  WORK_ITEM_BLOCKED: "WORK_ITEM_BLOCKED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  UPSTREAM_FAILED: "UPSTREAM_FAILED",
  UNKNOWN_STATE: "UNKNOWN_STATE",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCategory = {
  SCHEMA: "SCHEMA",
  POLICY: "POLICY",
  IDEMPOTENCY: "IDEMPOTENCY",
  UPSTREAM: "UPSTREAM",
  EXECUTION: "EXECUTION",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

// ─── Risk Levels ─────────────────────────────────────────────────────────────

export const RiskLevel = {
  FREE: "free",
  APPROVAL: "approval",
  FORBIDDEN: "forbidden",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export function classifyRisk(operation: string, registry: OperationRegistryEntry): RiskLevel {
  return (registry[operation]?.risk as RiskLevel) ?? RiskLevel.FORBIDDEN;
}

// ─── Operation Registry ───────────────────────────────────────────────────────

export interface OperationRegistryEntry {
  [operation: string]: {
    risk: "free" | "approval" | "forbidden";
    mutation: boolean;
    requiresIdempotencyKey: boolean;
    httpMethod: string;
    httpPath: string;
    approvalClass?: string;
    approval?: {
      severity: string;
      allowedDecisions: string[];
      timeoutBehavior: string;
    };
  };
}

// ─── Idempotency Store Types ─────────────────────────────────────────────────

export type IdempotencyStatus = "pending" | "completed" | "failed" | "unknown";

export interface IdempotencyRecord {
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseBody: unknown;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
