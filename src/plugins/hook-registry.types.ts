// Defines plugin hook registry entry and dispatch types.
import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";
import type { PluginTrustedToolPolicyRegistryRegistration } from "./registry-types.js";

/** Legacy hook registration stored by the global hook runner registry. */
export type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

/** Hook runner registry state for legacy and typed plugin hooks. */
export type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
};

/** Global hook runner registry snapshot with plugin load status. */
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
