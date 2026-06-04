// Minimal, fail-closed Policy Guard client for the bundled plugin.
//
// The bundled extension cannot import the workspace `policy-guard-client`
// package, so this mirrors its contract: POST the control-plane /api/core/enforce
// endpoint with the agent identity + tool, and map the decision. Uses global
// fetch (no extra deps) and a tiny TTL cache so toggles apply within seconds
// without a per-call network round-trip on every tool invocation.

import { randomUUID } from "node:crypto";

export type EnforceDecision = "allow" | "deny" | "require_approval";
export type ResponderSurface = "openclaw_hold" | "paperclip_board";

export interface EnforceResult {
  decision: EnforceDecision;
  reason?: string;
  approvalClass?: string;
  slaSeconds?: number;
  // Policy Matrix Engine routing (present on require_approval).
  responderSurface?: ResponderSurface;
  traceId?: string;
  approvalRequestId?: string;
  paperclipApprovalType?: string | null;
  escalationRole?: string | null;
}

export interface PolicyClientConfig {
  /** Full URL of the enforce endpoint, e.g. http://control-plane:3000/api/core/enforce */
  url: string;
  /** Shared service token (X-Service-Token). */
  serviceToken: string;
  /** Caller identity for X-Caller-Service (always "openclaw" here). */
  callerService: string;
  callerVersion: string;
  /** Caller role (required by enforce; not used in the tool decision). */
  role: string;
  /** What to do when the control plane is unreachable / errors. */
  failMode: "deny" | "allow";
  timeoutMs?: number;
  /** How long an allow/deny decision is cached per (package, tool). Default 5s. */
  cacheTtlMs?: number;
}

export interface EnforceToolInput {
  tenantId: string;
  employeeId: string;
  package: string;
  toolId: string;
  // Reuse a prior session_id to trigger enforce()'s idempotency replay (used by
  // the surface-② resume so an approved board hold re-attempts as allow). Omit
  // for normal calls — a fresh uuid is generated.
  sessionId?: string;
}

interface EnforceResponseBody {
  decision?: string;
  deny_reason?: string;
  deny_detail?: string;
  approval_class?: string;
  sla_seconds?: number;
  trace_id?: string;
  approval_request_id?: string;
  responder_surface?: string;
  routing?: {
    rule_id?: string | null;
    paperclip_approval_type?: string | null;
    escalation_role?: string | null;
  };
}

function uuid(): string {
  return randomUUID();
}

export interface PolicyClient {
  enforceTool(input: EnforceToolInput): Promise<EnforceResult>;
}

export function createPolicyClient(cfg: PolicyClientConfig): PolicyClient {
  const ttl = cfg.cacheTtlMs ?? 5_000;
  const timeoutMs = cfg.timeoutMs ?? 8_000;
  const cache = new Map<string, { result: EnforceResult; expires: number }>();

  function failClosed(reason: string): EnforceResult {
    return cfg.failMode === "allow" ? { decision: "allow", reason } : { decision: "deny", reason };
  }

  function mapDecision(body: EnforceResponseBody): EnforceResult {
    const decision = body.decision;
    if (decision === "allow") return { decision: "allow" };
    if (decision === "require_approval") {
      return {
        decision: "require_approval",
        approvalClass: body.approval_class,
        slaSeconds: body.sla_seconds,
        responderSurface:
          body.responder_surface === "paperclip_board" ? "paperclip_board" : "openclaw_hold",
        traceId: body.trace_id,
        approvalRequestId: body.approval_request_id,
        paperclipApprovalType: body.routing?.paperclip_approval_type ?? null,
        escalationRole: body.routing?.escalation_role ?? null,
      };
    }
    // Treat anything else (incl. "deny") as deny.
    return { decision: "deny", reason: body.deny_reason ?? body.deny_detail };
  }

  return {
    async enforceTool(input: EnforceToolInput): Promise<EnforceResult> {
      const key = `${input.package}:${input.toolId}`;
      // A reused session_id (surface-② resume) must always hit enforce so the
      // idempotency replay can return allow — never serve it from the cache.
      if (!input.sessionId) {
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.result;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": cfg.serviceToken,
            "X-Caller-Service": cfg.callerService,
            "X-Caller-Version": cfg.callerVersion,
            "X-Trace-Id": uuid(),
          },
          body: JSON.stringify({
            tenant_id: input.tenantId,
            employee_id: input.employeeId,
            package: input.package,
            role: cfg.role,
            caller_version: cfg.callerVersion,
            intent_kind: "tool",
            tool_id: input.toolId,
            // Unique per call so the control-plane idempotency window never
            // collides distinct tool evaluations — UNLESS the caller reuses a
            // prior session_id to trigger the surface-② approval replay.
            session_id: input.sessionId ?? uuid(),
            caller_service: cfg.callerService,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // 5xx is fail-closed; 4xx (misconfig/denied caller) is also fail-closed
          // since we cannot trust an unauthenticated decision.
          return failClosed(`enforce HTTP ${res.status}`);
        }

        const body = (await res.json()) as EnforceResponseBody;
        const result = mapDecision(body);
        // Cache only stable allow/deny outcomes, not approvals.
        if (result.decision !== "require_approval") {
          cache.set(key, { result, expires: Date.now() + ttl });
        }
        return result;
      } catch (err) {
        return failClosed(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
