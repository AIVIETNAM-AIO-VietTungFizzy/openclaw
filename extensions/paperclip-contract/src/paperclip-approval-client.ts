// Surface-② board-approval client: creates a Paperclip board/CEO approval when the
// Policy Matrix Engine routes a held tool to `paperclip_board`. The control-plane
// trace_id is embedded in the approval payload as the cross-system join key; when
// the board approves, Paperclip POSTs the resume_callback_url which flips the
// control-plane approval_requests row to approved — after which the agent's
// re-attempt (reusing the original session_id) is allowed by enforce()'s replay.

export interface CreateBoardApprovalArgs {
  /** Per-tenant Paperclip base URL, e.g. http://paperclip-<tenant>:3100 */
  baseUrl: string;
  companyId: string;
  /**
   * Paperclip agent UUID, so Paperclip can wake the agent on approve. Optional —
   * omit (→ null) when the caller isn't a registered Paperclip agent (e.g. a
   * standalone gateway); the resume callback still unblocks the hold.
   */
  requestedByAgentId?: string | null;
  /** One of Paperclip APPROVAL_TYPES (request_board_approval, approve_ceo_strategy, …). */
  approvalType: string;
  /** Control-plane approval_requests.trace_id — the cross-system join key. */
  traceId: string;
  /** Control-plane approval_requests.approval_id (for reference). */
  approvalRequestId: string;
  toolKey: string;
  /** Control-plane resume endpoint Paperclip calls on decide. */
  resumeCallbackUrl: string;
  timeoutMs?: number;
}

export type CreateBoardApprovalResult =
  | { ok: true; approvalId: string }
  | { ok: false; error: string };

export async function createPaperclipBoardApproval(
  args: CreateBoardApprovalArgs,
): Promise<CreateBoardApprovalResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${args.baseUrl}/api/companies/${args.companyId}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: args.approvalType,
        // null when not a registered Paperclip agent (avoids the agent FK).
        requestedByAgentId: args.requestedByAgentId ?? null,
        payload: {
          source: "openclaw_policy_matrix",
          control_plane_trace_id: args.traceId,
          control_plane_approval_id: args.approvalRequestId,
          tool_key: args.toolKey,
          resume_callback_url: args.resumeCallbackUrl,
          title: `Approve tool: ${args.toolKey}`,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `paperclip approvals HTTP ${res.status} ${text.slice(0, 160)}` };
    }
    const body = (await res.json()) as { id?: string };
    if (!body?.id) return { ok: false, error: "paperclip approval response missing id" };
    return { ok: true, approvalId: body.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
