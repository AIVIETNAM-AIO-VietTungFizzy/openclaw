import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";
import type { PluginTrustedToolPolicyRegistryRegistration } from "./registry-types.js";

export type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
};

export type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    status: "loaded" | "disabled" | "error";
  }>;
  // Trusted tool policies enforce host safety ahead of before_tool_call hooks.
  // They ride on the preserved global-runner registry, not the mutable active
  // plugin registry, so scoped harness/provider cold-loads (which replace the
  // active registry with e.g. ["codex","openai"]) cannot drop the enforcement
  // set — identical lifecycle to the hooks above.
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
};
