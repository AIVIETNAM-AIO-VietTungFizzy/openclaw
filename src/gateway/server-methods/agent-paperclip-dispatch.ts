// Gap 1.5 host-side capture: persist the Paperclip Layer 4B dispatch payload
// (incl. the V24 session envelope) as a session extension under
// paperclip-contract/"dispatch" so the plugin's trusted policy enforces the
// run with the DISPATCHED per-employee identity. The plugin registers the
// extension namespace at load time; the patch is BEST-EFFORT — a failure only
// warns, never fails the run (the plugin then falls back to the container's
// static identity, which is fail-safe).

export const PAPERCLIP_DISPATCH_PLUGIN_ID = "paperclip-contract";
export const PAPERCLIP_DISPATCH_NAMESPACE = "dispatch";

export async function persistPaperclipDispatch(params: {
  paperclip: unknown;
  sessionKey: string | undefined | null;
  patch: (args: {
    sessionKey: string;
    pluginId: string;
    namespace: string;
    value: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
  warn: (message: string) => void;
}): Promise<void> {
  const { paperclip, sessionKey } = params;
  if (!paperclip || typeof paperclip !== "object" || Array.isArray(paperclip)) return;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
  try {
    const result = await params.patch({
      sessionKey,
      pluginId: PAPERCLIP_DISPATCH_PLUGIN_ID,
      namespace: PAPERCLIP_DISPATCH_NAMESPACE,
      value: paperclip as Record<string, unknown>,
    });
    if (!result.ok) {
      params.warn(
        `paperclip dispatch payload not persisted for ${sessionKey}: ${result.error ?? "patch failed"}`,
      );
    }
  } catch (err) {
    params.warn(
      `paperclip dispatch payload not persisted for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
