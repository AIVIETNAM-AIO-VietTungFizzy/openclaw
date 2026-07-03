import { randomUUID } from "node:crypto";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { Type } from "typebox";
import { createFacade, type FacadeConfig } from "./src/facade.js";
import {
  classifyToolCall,
  classifyOperationRisk,
  resolveApprovalRouting,
  DANGEROUS_RAW_TOOLS,
} from "./src/guard.js";
import { createPaperclipBoardApproval } from "./src/paperclip-approval-client.js";
import { createPolicyClient, type PolicyClient } from "./src/policy-client.js";

const FACADE_TOOL_NAME = "paperclip_contract_call";
const DEFAULT_BASE_URL = "http://paperclip-4b:8080";
const PLUGIN_VERSION = "2026.5.31";

// Bundle-mcp namespaces aggregated MCP tools as "<server>__<connector>__<tool>"
// (its TOOL_NAME_SEPARATOR is "__"). Native OpenClaw tools (exec, web_fetch,
// browser, paperclip_contract_call) never contain the separator. These aggregated
// tools are governed downstream at the LiteLLM /mcp chokepoint under their
// canonical connector id; this plugin must not re-enforce them under the OpenClaw
// display name (which CP can't resolve → connector_tool_not_found, surfaced as a
// misleading "not permitted for your package" block).
const BUNDLE_MCP_TOOL_SEPARATOR = "__";
function isBundleMcpTool(toolName: unknown): boolean {
  return typeof toolName === "string" && toolName.includes(BUNDLE_MCP_TOOL_SEPARATOR);
}

type BeforeToolCallResult = Record<string, unknown>;

interface PolicyIdentity {
  tenantId: string;
  employeeId: string;
  package: string;
}

/** Paperclip board (surface ②) routing config — present only when fully set. */
interface BoardConfig {
  baseUrl: string;
  companyId: string;
  /** Optional: the Paperclip agent UUID for heartbeat wakeup. null when absent. */
  agentId?: string;
  resumeCallbackUrl: string;
}

interface ResolvedConfig {
  facade: FacadeConfig;
  /** Present only when the control-plane Policy Guard is fully configured. */
  policy: { client: PolicyClient; identity: PolicyIdentity } | null;
  /** Present only when surface-② (Paperclip board) routing is fully configured. */
  board: BoardConfig | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve config from the plugin config (`api.config`, injected by the host /
 * agent-server) with environment fallbacks. When the Policy Guard URL + service
 * token + agent identity are all present, tool decisions are delegated to the
 * control-plane; otherwise the plugin falls back to its static guard so local /
 * manual runs keep working.
 */
function readConfig(api: OpenClawPluginApi): ResolvedConfig {
  // The plugin's own entry config (plugins.entries.paperclip-contract.config) is
  // exposed as api.pluginConfig; api.config is the full gateway config and does
  // NOT carry policyGuardUrl/tenantId/etc. Reading api.config left `policy` null,
  // silently dropping the plugin into legacy mode (static guard, no control-plane
  // governance). Prefer pluginConfig, fall back to api.config then env vars.
  const cfg = (api.pluginConfig ?? api.config ?? {}) as Record<string, unknown>;

  const baseUrl = str(cfg.baseUrl) ?? process.env.PAPERCLIP_BASE_URL ?? DEFAULT_BASE_URL;
  const targetEnv = str(cfg.targetEnv) ?? process.env.PAPERCLIP_TARGET_ENV;
  const facade: FacadeConfig = { paperclip: { baseUrl }, targetEnv };

  const url = str(cfg.policyGuardUrl) ?? process.env.PAPERCLIP_POLICY_GUARD_URL;
  const serviceToken = str(cfg.serviceToken) ?? process.env.PAPERCLIP_SERVICE_TOKEN;
  const tenantId = str(cfg.tenantId) ?? process.env.PAPERCLIP_TENANT_ID;
  const employeeId = str(cfg.employeeId) ?? process.env.PAPERCLIP_EMPLOYEE_ID;
  const pkg = str(cfg.package) ?? process.env.PAPERCLIP_PACKAGE;
  const failMode =
    (str(cfg.failMode) ?? process.env.PAPERCLIP_FAIL_MODE) === "allow" ? "allow" : "deny";
  const ttlRaw = cfg.cacheTtlMs ?? process.env.PAPERCLIP_CACHE_TTL_MS;
  const cacheTtlMs = ttlRaw != null && Number.isFinite(Number(ttlRaw)) ? Number(ttlRaw) : undefined;

  let policy: ResolvedConfig["policy"] = null;
  if (url && serviceToken && tenantId && employeeId && pkg) {
    const role = str(cfg.role) ?? process.env.PAPERCLIP_ROLE ?? "agent";
    const client = createPolicyClient({
      url,
      serviceToken,
      callerService: "openclaw",
      callerVersion: PLUGIN_VERSION,
      role,
      failMode,
      cacheTtlMs,
      // V24 session-envelope identity (gaps item 1.2) — optional; the envelope
      // builder fills channel/agent defaults when unset.
      companyId: str(cfg.companyId) ?? process.env.PAPERCLIP_COMPANY_ID,
      locale: str(cfg.locale) ?? process.env.PAPERCLIP_LOCALE,
      timezone: str(cfg.timezone) ?? process.env.PAPERCLIP_TIMEZONE,
      runtimeLane: str(cfg.runtimeLane) ?? process.env.PAPERCLIP_RUNTIME_LANE,
      channelUsed: str(cfg.channelUsed) ?? process.env.PAPERCLIP_CHANNEL_USED,
      agentUsed: str(cfg.agentUsed) ?? process.env.PAPERCLIP_AGENT_USED,
    });
    policy = { client, identity: { tenantId, employeeId, package: pkg } };
  }

  // Surface-② (Paperclip board) routing config. The resume callback URL defaults
  // to the control-plane derived from the policyGuardUrl (…/enforce → …/approvals/resume).
  const companyId = str(cfg.companyId) ?? process.env.PAPERCLIP_COMPANY_ID;
  const agentId = str(cfg.agentId) ?? process.env.PAPERCLIP_AGENT_ID;
  const resumeCallbackUrl =
    str(cfg.resumeCallbackUrl) ??
    process.env.PAPERCLIP_RESUME_CALLBACK_URL ??
    (url ? url.replace(/\/api\/core\/enforce\/?$/, "/api/core/approvals/resume") : undefined);
  // Board routing needs a company + a resume callback; the agent id is optional
  // (only used for Paperclip's heartbeat wakeup).
  const board: BoardConfig | null =
    companyId && resumeCallbackUrl ? { baseUrl, companyId, agentId, resumeCallbackUrl } : null;

  return { facade, policy, board };
}

const EnvelopeToolSchema = Type.Object(
  {
    envelope: Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "ContractEnvelope: contractVersion, requestId, operation, idempotencyKey, traceId, caller, params.",
      },
    ),
  },
  { additionalProperties: false },
);

function toApprovalSeverity(severity: string): "info" | "warning" | "critical" {
  if (severity === "critical") return "critical";
  if (severity === "info" || severity === "low") return "info";
  return "warning";
}

function approvalClassSeverity(approvalClass?: string): "info" | "warning" | "critical" {
  if (approvalClass === "A3" || approvalClass === "A4") return "critical";
  if (approvalClass === "A0") return "info";
  return "warning";
}

/**
 * Operation-level contract risk for the facade tool (e.g. complete_work_item
 * needs approval, unknown operations are blocked). Applied AFTER tool-level
 * governance has allowed the facade tool itself.
 */
function facadeOperationDecision(event: { params?: unknown }): BeforeToolCallResult {
  const params = event.params as { envelope?: { operation?: string } } | undefined;
  const operation = params?.envelope?.operation;
  if (!operation) return {}; // facade returns INVALID_REQUEST on a bad envelope

  const opClass = classifyOperationRisk(operation);
  if (opClass.outcome === "block") {
    return { block: true, blockReason: opClass.message };
  }
  if (opClass.outcome === "approval_required") {
    const routing = resolveApprovalRouting(opClass.approvalClass);
    return {
      requireApproval: {
        title: `Approve ${operation}`,
        description: `Operation '${operation}' (class ${opClass.approvalClass}) requires approval before it runs.`,
        severity: toApprovalSeverity(opClass.severity),
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: routing.timeoutSeconds * 1000,
        timeoutBehavior: "deny",
      },
    };
  }
  return {};
}

/**
 * Dispatched per-run identity (gap 1.5): the gateway agent handler stores the
 * Paperclip dispatch payload as a session extension under the "dispatch"
 * namespace; its envelope re-points enforcement at the DISPATCHED employee.
 * SECURITY GATE: an envelope for another tenant is ignored (and logged) — a
 * dispatch must never re-point enforcement across tenants. Only employee_id
 * and trace_id are honored; package/role stay the container's provisioned
 * identity (a dispatch must not elevate privileges).
 */
function readDispatchedIdentity(
  ctx: { getSessionExtension?: (namespace: string) => unknown } | undefined,
  configuredTenantId: string,
): { employeeId?: string; traceId?: string } | null {
  const raw = ctx?.getSessionExtension?.("dispatch");
  if (!raw || typeof raw !== "object") return null;
  const envelope = (raw as { envelope?: unknown }).envelope;
  if (!envelope || typeof envelope !== "object") return null;
  const env = envelope as Record<string, unknown>;
  const tenantId = typeof env.tenant_id === "string" ? env.tenant_id : null;
  if (tenantId !== configuredTenantId) {
    if (tenantId) {
      console.warn(
        `[paperclip-contract] ignoring dispatched envelope for foreign tenant ${tenantId}`,
      );
    }
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return { employeeId: str(env.employee_id), traceId: str(env.trace_id) };
}

/** Static fallback used when the control-plane Policy Guard is not configured. */
function legacyEvaluate(event: { toolName: string; params?: unknown }): BeforeToolCallResult {
  const toolClass = classifyToolCall(event.toolName);
  if (toolClass.outcome === "block") {
    return { block: true, blockReason: toolClass.message };
  }
  if (event.toolName !== FACADE_TOOL_NAME) return {};
  return facadeOperationDecision(event);
}

export default definePluginEntry({
  id: "paperclip-contract",
  name: "Paperclip Contract Plugin",
  description:
    "Governs OpenClaw tool use against the control-plane Policy Guard (per-package allow/deny/approval) and routes Paperclip Layer 4B operations through a frozen contract. Falls back to a static guard when the control plane is not configured.",
  register(api: OpenClawPluginApi) {
    const { facade, policy, board } = readConfig(api);
    const { call } = createFacade(facade);

    // In-process surface-② board holds: maps (tenant:employee:tool) → the original
    // enforce session_id so a woken re-attempt replays the now-approved decision.
    // Lost on gateway restart (a restart-then-retry just re-submits — safe).
    const boardHolds = new Map<string, { sessionId: string; traceId: string; expiresAt: number }>();

    // ── Facade tool: the single governed entry point the agent may call ──────
    api.registerTool({
      name: FACADE_TOOL_NAME,
      label: "Paperclip Contract Call",
      description:
        "Execute a Paperclip Layer 4B operation (ready_work, work_item_detail, raise_blocker, complete_work_item) governed by the OpenClaw/Paperclip contract. Provide a valid ContractEnvelope as `envelope`.",
      parameters: EnvelopeToolSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const result = await call(rawParams.envelope);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.response) }],
          details: result.response,
        };
      },
    } as AnyAgentTool);

    // ── Trusted tool policy: runs BEFORE all ordinary before_tool_call hooks ──
    // Gap 1.5: the gateway agent handler persists Paperclip dispatch payloads
    // into this session-extension namespace (host-side patch requires the
    // extension to be registered). readDispatchedIdentity() consumes it.
    api.registerSessionExtension?.({
      namespace: "dispatch",
      description: "Paperclip Layer 4B dispatch payload (V24 session envelope) for the active run.",
    });

    api.registerTrustedToolPolicy({
      id: "paperclip-contract-policy",
      description:
        "Delegates tool allow/deny/approval to the control-plane Policy Guard per package; still applies operation-level contract risk for the Paperclip facade. Falls back to a static guard when unconfigured.",
      async evaluate(event, ctx): Promise<BeforeToolCallResult> {
        // Bundle-mcp aggregated tools are governed at the LiteLLM /mcp chokepoint
        // (with their canonical connector id); re-enforcing them here under the
        // OpenClaw display name yields a false "not permitted for your package".
        // Pass them through untouched. (Native tools have no "__".)
        if (isBundleMcpTool(event.toolName)) return {};

        // No control plane configured → static behavior (keeps local/manual runs working).
        if (!policy) return legacyEvaluate(event);

        // Gap 1.5: a Paperclip dispatch re-points enforcement at the dispatched
        // employee (same tenant only — see readDispatchedIdentity).
        const dispatched = readDispatchedIdentity(ctx, policy.identity.tenantId);
        const effectiveEmployeeId = dispatched?.employeeId ?? policy.identity.employeeId;
        const holdKey = `${policy.identity.tenantId}:${effectiveEmployeeId}:${event.toolName}`;
        let hold = boardHolds.get(holdKey);
        if (hold && hold.expiresAt < Date.now()) {
          boardHolds.delete(holdKey);
          hold = undefined;
        }
        // We generate the session_id so it can be REUSED on a surface-② resume
        // re-attempt — that triggers enforce()'s idempotency replay (allow once
        // the board has approved). Normal calls get a fresh uuid each time.
        const sessionId = hold?.sessionId ?? randomUUID();

        // Tool-level governance via the control plane (covers exec, web_fetch,
        // browser, paperclip_contract_call, …).
        const decision = await policy.client.enforceTool({
          tenantId: policy.identity.tenantId,
          employeeId: effectiveEmployeeId,
          package: policy.identity.package,
          toolId: event.toolName,
          sessionId,
          ...(dispatched?.traceId ? { traceId: dispatched.traceId } : {}),
        });

        if (decision.decision === "deny") {
          if (hold) {
            // Re-attempt while the board approval is still pending (the replay was
            // denied as idempotency_key_reused) → keep waiting, don't re-submit.
            return {
              block: true,
              blockReason:
                "Still awaiting Paperclip board approval for this action — try again after the board decides.",
            };
          }
          return {
            block: true,
            blockReason: "This action is not permitted for your current package.",
          };
        }
        if (
          decision.decision === "allow" &&
          decision.fallback &&
          DANGEROUS_RAW_TOOLS.includes(event.toolName)
        ) {
          // Fail-open only softens BENIGN tools. A fallback allow is not an
          // explicit Core decision, and the dangerous set never executes
          // without one (gap 1.3 acceptance).
          return {
            block: true,
            blockReason: `'${event.toolName}' requires an explicit Core allow and the control plane is unreachable (fail-open applies to benign tools only).`,
          };
        }
        if (decision.decision === "redirect_lane") {
          // Gap 1.3: the Core redirected this Act to another runtime lane.
          // Lane workers (7A/7B/Edge) are not wired yet, so surface a replan
          // signal instead of executing here.
          return {
            block: true,
            blockReason: `The Deterministic Core redirected this action to lane ${decision.redirectLane} — replan and route the task through that lane instead of executing it here.`,
          };
        }
        if (decision.decision === "require_approval") {
          // Policy Matrix Engine routed this hold to the Paperclip board (②).
          if (decision.responderSurface === "paperclip_board") {
            if (!board) {
              return {
                block: true,
                blockReason:
                  "This action needs board approval, but Paperclip board routing is not configured.",
              };
            }
            const created = await createPaperclipBoardApproval({
              baseUrl: board.baseUrl,
              companyId: board.companyId,
              requestedByAgentId: board.agentId,
              approvalType: decision.paperclipApprovalType ?? "request_board_approval",
              traceId: decision.traceId ?? "",
              approvalRequestId: decision.approvalRequestId ?? "",
              toolKey: event.toolName,
              resumeCallbackUrl: board.resumeCallbackUrl,
            });
            if (!created.ok) {
              return {
                block: true,
                blockReason: `Could not submit '${event.toolName}' to the Paperclip board: ${created.error}`,
              };
            }
            boardHolds.set(holdKey, {
              sessionId,
              traceId: decision.traceId ?? "",
              expiresAt: Date.now() + (decision.slaSeconds ?? 3600) * 1000,
            });
            return {
              block: true,
              blockReason: `'${event.toolName}' was submitted to the Paperclip board (approval ${created.approvalId}). It will run once the board approves and you retry the action.`,
            };
          }
          // Default surface ①: synchronous in-gateway operator hold.
          return {
            requireApproval: {
              title: `Approve ${event.toolName}`,
              description: `Tool '${event.toolName}'${
                decision.approvalClass ? ` (class ${decision.approvalClass})` : ""
              } requires approval before it runs.`,
              severity: approvalClassSeverity(decision.approvalClass),
              allowedDecisions: ["allow-once", "deny"],
              timeoutMs: (decision.slaSeconds ?? 300) * 1000,
              timeoutBehavior: "deny",
            },
          };
        }

        // Allowed. If a board hold was satisfied (approved → replayed), clear it.
        if (hold) boardHolds.delete(holdKey);
        // Surface the Core's authorization envelope (gap 1.3) so downstream
        // consumers (agent loop / audit) can honor allowed_tools / max_cost.
        const passResult = decision.constraints ? { constraints: decision.constraints } : {};
        // The facade tool additionally carries operation-level risk.
        if (event.toolName !== FACADE_TOOL_NAME) return passResult;
        return { ...facadeOperationDecision(event), ...passResult };
      },
    });
  },
});
