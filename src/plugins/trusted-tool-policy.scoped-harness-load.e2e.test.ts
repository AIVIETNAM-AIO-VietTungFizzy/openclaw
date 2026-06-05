import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBundledPluginsDirOverrideForTest } from "./bundled-dir.js";
import { resetGlobalHookRunner } from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import { getActivePluginRegistry, resetPluginRuntimeStateForTest } from "./runtime.js";
import {
  getTrustedToolPolicyDiagnosticEntries,
  hasTrustedToolPolicies,
  runTrustedToolPolicies,
} from "./trusted-tool-policy.js";

// Reproduces the real bug behind "Run the command: date": a Codex/Copilot run
// cold-loads only its provider plugins (["codex","openai"]) and replaces the
// active plugin registry, which used to drop the bundled paperclip-contract
// trusted policy so native command execution bypassed it. The fix sources
// trusted policies from the preserved global-runner registry, so the policy
// must still evaluate after the scoped load. We drive the scoped harness load
// with a lightweight bundled plugin (the swap, not which plugin, is what
// matters); the production trigger is ["codex","openai"].
describe("trusted policy survives scoped harness cold-load (paperclip-contract)", () => {
  beforeEach(() => {
    setBundledPluginsDirOverrideForTest(path.join(process.cwd(), "extensions"));
    // No control plane configured → paperclip falls back to its static guard.
    delete process.env.PAPERCLIP_POLICY_GUARD_URL;
    resetPluginRuntimeStateForTest();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    setBundledPluginsDirOverrideForTest(undefined);
    resetPluginRuntimeStateForTest();
    resetGlobalHookRunner();
  });

  it("still evaluates paperclip-contract-policy for a `date` command after a Codex-style scoped load", async () => {
    // 1. Full gateway-bindable load registers the paperclip trusted policy.
    const full = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["paperclip-contract"],
      config: { plugins: { entries: { "paperclip-contract": { enabled: true } } } },
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    expect(full.plugins.find((plugin) => plugin.id === "paperclip-contract")?.status).toBe(
      "loaded",
    );
    expect(getTrustedToolPolicyDiagnosticEntries().map((entry) => entry.id)).toContain(
      "paperclip-contract-policy",
    );
    expect(hasTrustedToolPolicies()).toBe(true);

    // 2. Scoped default-mode cold-load replaces the active registry (stands in for
    //    the Codex ["codex","openai"] harness load) and triggers the same
    //    preserveGatewayHookRunner path the harness run uses.
    const scoped = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["tokenjuice"],
      config: { plugins: { entries: { tokenjuice: { enabled: true } } } },
    });
    expect(scoped.plugins.some((plugin) => plugin.id === "paperclip-contract")).toBe(false);
    // The active registry no longer carries the policy — enforcement must not depend on it.
    expect(getActivePluginRegistry()?.trustedToolPolicies ?? []).toHaveLength(0);

    // 3. The policy is still enforced from the preserved global-runner registry.
    expect(hasTrustedToolPolicies()).toBe(true);
    const result = await runTrustedToolPolicies(
      { toolName: "exec", params: { command: "date" } },
      { toolName: "exec" },
    );
    expect(result).toMatchObject({ block: true });
    expect(result?.blockReason).toContain("paperclip_contract_call");
  });
});
