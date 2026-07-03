import { describe, expect, it, vi } from "vitest";
import { persistPaperclipDispatch } from "./agent-paperclip-dispatch.js";

// Gap 1.5 host-side capture: the gateway agent handler persists the Paperclip
// dispatch payload as a session extension (paperclip-contract/dispatch) so the
// trusted policy enforces the run with the DISPATCHED identity. Best-effort:
// failures warn, never throw (the plugin falls back to the static identity).

describe("persistPaperclipDispatch", () => {
  const PAYLOAD = { runId: "r1", envelope: { tenant_id: "ten-1", employee_id: "emp-9" } };

  it("patches the paperclip-contract/dispatch session extension with the payload", async () => {
    const patch = vi.fn().mockResolvedValue({ ok: true });
    const warn = vi.fn();
    await persistPaperclipDispatch({
      paperclip: PAYLOAD,
      sessionKey: "agent:main:paperclip:issue:9",
      patch,
      warn,
    });
    expect(patch).toHaveBeenCalledWith({
      sessionKey: "agent:main:paperclip:issue:9",
      pluginId: "paperclip-contract",
      namespace: "dispatch",
      value: PAYLOAD,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing without a payload or without a session key", async () => {
    const patch = vi.fn();
    const warn = vi.fn();
    await persistPaperclipDispatch({ paperclip: undefined, sessionKey: "k", patch, warn });
    await persistPaperclipDispatch({ paperclip: PAYLOAD, sessionKey: undefined, patch, warn });
    await persistPaperclipDispatch({ paperclip: "not-an-object", sessionKey: "k", patch, warn });
    expect(patch).not.toHaveBeenCalled();
  });

  it("warns (never throws) when the patch reports failure or throws", async () => {
    const warn = vi.fn();
    await persistPaperclipDispatch({
      paperclip: PAYLOAD,
      sessionKey: "k",
      patch: vi.fn().mockResolvedValue({ ok: false, error: "unknown plugin session extension" }),
      warn,
    });
    await persistPaperclipDispatch({
      paperclip: PAYLOAD,
      sessionKey: "k",
      patch: vi.fn().mockRejectedValue(new Error("boom")),
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
