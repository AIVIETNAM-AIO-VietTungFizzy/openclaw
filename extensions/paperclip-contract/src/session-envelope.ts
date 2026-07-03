// V24 per-employee session envelope (architecture-gaps item 1.2).
//
// Every enforce() call must carry the full session identity so the
// Deterministic Core can make policy/budget/audit decisions. This module owns
// the payload shape: buildEnforcePayload() composes identity (static config)
// with per-call intent and validates via zod — an invalid/missing envelope
// throws, which the policy client maps to its fail mode instead of silently
// sending a partial envelope.

import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SessionEnvelopeSchema = z.object({
  // ── identity (metadata) ──
  tenant_id: z.string().min(1),
  employee_id: z.string().min(1),
  company_id: z.string().min(1).optional(),
  package: z.string().min(1),
  role: z.string().min(1),
  locale: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  // ── tracing ──
  trace_id: z.string().min(1),
  trace_root: z.string().min(1),
  // ── runtime ──
  session_id: z.string().min(1),
  channel_used: z.string().min(1),
  agent_used: z.string().min(1),
  runtime_lane: z.string().min(1).optional(),
  // ── intent ──
  intent_kind: z.string().min(1),
  tool_id: z.string().min(1),
  // ── data / cost ──
  estimated_cost_usd: z.number().nonnegative().optional(),
  amount: z.number().optional(),
  currency: z.string().min(1).optional(),
  // ── caller provenance (pre-existing enforce contract) ──
  caller_service: z.string().min(1),
  caller_version: z.string().min(1),
});

export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>;

export interface EnvelopeIdentity {
  tenantId: string;
  employeeId: string;
  package: string;
  role: string;
  callerService: string;
  callerVersion: string;
  companyId?: string;
  locale?: string;
  timezone?: string;
  runtimeLane?: string;
  channelUsed?: string;
  agentUsed?: string;
}

export interface EnvelopeIntent {
  toolId: string;
  sessionId: string;
  traceId?: string;
  intentKind?: string;
  estimatedCostUsd?: number;
  amount?: number;
  currency?: string;
}

/**
 * trace_root deterministically names the (tenant, employee) span so all calls
 * for one employee correlate across services; trace_id is per call.
 */
function traceRoot(identity: EnvelopeIdentity): string {
  return `trace-root:${identity.tenantId}:${identity.employeeId}`;
}

export function buildEnforcePayload(
  identity: EnvelopeIdentity,
  intent: EnvelopeIntent,
): SessionEnvelope {
  return SessionEnvelopeSchema.parse({
    tenant_id: identity.tenantId,
    employee_id: identity.employeeId,
    ...(identity.companyId ? { company_id: identity.companyId } : {}),
    package: identity.package,
    role: identity.role,
    ...(identity.locale ? { locale: identity.locale } : {}),
    ...(identity.timezone ? { timezone: identity.timezone } : {}),
    trace_id: intent.traceId ?? randomUUID(),
    trace_root: traceRoot(identity),
    session_id: intent.sessionId,
    channel_used: identity.channelUsed ?? "openclaw_gateway",
    agent_used: identity.agentUsed ?? "openclaw:paperclip",
    ...(identity.runtimeLane ? { runtime_lane: identity.runtimeLane } : {}),
    intent_kind: intent.intentKind ?? "tool",
    tool_id: intent.toolId,
    ...(intent.estimatedCostUsd != null ? { estimated_cost_usd: intent.estimatedCostUsd } : {}),
    ...(intent.amount != null ? { amount: intent.amount } : {}),
    ...(intent.currency ? { currency: intent.currency } : {}),
    caller_service: identity.callerService,
    caller_version: identity.callerVersion,
  });
}
