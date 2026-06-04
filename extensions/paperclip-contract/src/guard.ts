import { getOperation, isKnownOperation } from "./registry.js";
import { RiskLevel, ErrorCode, ErrorCategory, type RiskLevel as RiskLevelType } from "./types.js";

// ─── Approval Routing Config ─────────────────────────────────────────────────

export interface ApprovalRoutingConfig {
  targetSurface: "slack" | "pagerduty" | "ui" | "email";
  timeoutSeconds: number;
  severityThresholds: {
    critical: number;
    high: number;
    warning: number;
    low: number;
  };
}

const DEFAULT_ROUTING: ApprovalRoutingConfig = {
  targetSurface: "slack",
  timeoutSeconds: 300,
  severityThresholds: { critical: 300, high: 600, warning: 900, low: 1200 },
};

const APPROVAL_ROUTING: Record<string, ApprovalRoutingConfig> = {
  A1: { ...DEFAULT_ROUTING, targetSurface: "slack" },
  A2: { ...DEFAULT_ROUTING, targetSurface: "pagerduty" },
  A3: { ...DEFAULT_ROUTING, targetSurface: "ui" },
  A4: { ...DEFAULT_ROUTING, targetSurface: "slack" },
};

export function resolveApprovalRouting(approvalClass: string): ApprovalRoutingConfig {
  return APPROVAL_ROUTING[approvalClass] ?? DEFAULT_ROUTING;
}

export interface ApprovalPromptResult {
  decision: "allow-once" | "deny";
  approvalId?: string;
}

export async function requireApproval(
  approvalClass: string,
  severity: string,
  promptPromise?: Promise<{ decision: "allow-once" | "deny" }>,
): Promise<ApprovalPromptResult> {
  const routing = resolveApprovalRouting(approvalClass);

  if (promptPromise) {
    const result = await promptPromise;
    if (result.decision === "deny") {
      throw new Error("approval denied");
    }
    return result;
  }

  // Default: auto-allow-once (for testing / no-prompt scenario)
  return { decision: "allow-once" };
}

export function isApprovalGranted(outcome: ApprovalPromptResult): boolean {
  return outcome.decision === "allow-once";
}

// ─── Guard Result ─────────────────────────────────────────────────────────────

export type GuardAction =
  | { outcome: "pass" }
  | { outcome: "block"; code: string; category: string; message: string }
  | { outcome: "approval_required"; approvalClass: string; severity: string };

// ─── Guard Classifier ─────────────────────────────────────────────────────────

export function classifyToolCall(toolName: string): GuardAction {
  // Block raw sub-tool bypass attempts
  const rawSubTools = [
    "paperclip.ready_work",
    "paperclip.work_item_detail",
    "paperclip.raise_blocker",
    "paperclip.complete_work_item",
    "exec",
    "process",
    "browser",
    "nodes",
  ];

  if (rawSubTools.includes(toolName)) {
    return {
      outcome: "block",
      code: ErrorCode.POLICY_DENIED,
      category: ErrorCategory.POLICY,
      message: `'${toolName}' is not directly accessible. Use 'paperclip_contract_call'.`,
    };
  }

  // Only paperclip_contract_call is the allowed facade
  if (toolName !== "paperclip_contract_call") {
    // Unknown non-paperclip tool — pass through to OpenClaw's default handling
    return { outcome: "pass" };
  }

  // paperclip_contract_call itself doesn't go through risk classification;
  // the facade handles operation-level risk. Guard just passes it through.
  return { outcome: "pass" };
}

/**
 * Classify an operation (from within a ContractEnvelope) by its risk level.
 * Used by the before_tool_call hook to gate approval-required operations.
 */
export function classifyOperationRisk(operation: string): GuardAction {
  if (!isKnownOperation(operation)) {
    return {
      outcome: "block",
      code: ErrorCode.UNKNOWN_OPERATION,
      category: ErrorCategory.POLICY,
      message: `Unknown operation '${operation}'`,
    };
  }

  const entry = getOperation(operation);
  const risk = (entry?.risk as RiskLevelType) ?? RiskLevel.FORBIDDEN;

  if (risk === RiskLevel.FORBIDDEN) {
    return {
      outcome: "block",
      code: ErrorCode.POLICY_DENIED,
      category: ErrorCategory.POLICY,
      message: `Operation '${operation}' is forbidden`,
    };
  }

  if (risk === RiskLevel.APPROVAL) {
    const approvalClass = entry?.approvalClass ?? "A0";
    const severity = entry?.approval?.severity ?? "warning";
    return {
      outcome: "approval_required",
      approvalClass,
      severity,
    };
  }

  return { outcome: "pass" };
}
