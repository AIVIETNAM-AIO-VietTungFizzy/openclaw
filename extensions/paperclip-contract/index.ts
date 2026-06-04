import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { Type } from "typebox";
import { createFacade, type FacadeConfig } from "./src/facade.js";
import { classifyToolCall, classifyOperationRisk, resolveApprovalRouting } from "./src/guard.js";
import { createPolicyClient, type PolicyClient } from "./src/policy-client.js";

const FACADE_TOOL_NAME = "paperclip_contract_call";
const DEFAULT_BASE_URL = "http://paperclip-4b:8080";
const PLUGIN_VERSION = "2026.5.31";

type BeforeToolCallResult = Record<string, unknown>;

interface PolicyIdentity {
  tenantId: string;
  employeeId: string;
  package: string;
}

interface ResolvedConfig {
  facade: FacadeConfig;
  /** Present only when the control-plane Policy Guard is fully configured. */
  policy: { client: PolicyClient; identity: PolicyIdentity } | null;
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
  const cfg = (api.config ?? {}) as Record<string, unknown>;

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
    });
    policy = { client, identity: { tenantId, employeeId, package: pkg } };
  }
  return { facade, policy };
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
    const { facade, policy } = readConfig(api);
    const { call } = createFacade(facade);

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
    api.registerTrustedToolPolicy({
      id: "paperclip-contract-policy",
      description:
        "Delegates tool allow/deny/approval to the control-plane Policy Guard per package; still applies operation-level contract risk for the Paperclip facade. Falls back to a static guard when unconfigured.",
      async evaluate(event): Promise<BeforeToolCallResult> {
        // No control plane configured → static behavior (keeps local/manual runs working).
        if (!policy) return legacyEvaluate(event);

        // Tool-level governance via the control plane (covers exec, web_fetch,
        // browser, paperclip_contract_call, …).
        const decision = await policy.client.enforceTool({
          tenantId: policy.identity.tenantId,
          employeeId: policy.identity.employeeId,
          package: policy.identity.package,
          toolId: event.toolName,
        });

        if (decision.decision === "deny") {
          return {
            block: true,
            blockReason: "This action is not permitted for your current package.",
          };
        }
        if (decision.decision === "require_approval") {
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

        // Allowed. The facade tool additionally carries operation-level risk.
        if (event.toolName !== FACADE_TOOL_NAME) return {};
        return facadeOperationDecision(event);
      },
    });
  },
});
