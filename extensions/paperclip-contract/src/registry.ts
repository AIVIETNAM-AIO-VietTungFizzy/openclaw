// Static import: the bundler inlines the registry, so there is no runtime fs read
// (which would break inside the bundled OpenClaw image).
import registryData from "../contracts/paperclip-openclaw-operation-registry.v1.json" with { type: "json" };
import type { OperationRegistryEntry } from "./types.js";

export function loadRegistry(): unknown {
  return registryData;
}

/**
 * Return the operations map, handling both wrapped ({ operations: {...} }) and
 * flat formats.
 */
function getOperations(): OperationRegistryEntry {
  const reg = registryData as Record<string, unknown>;
  const ops = reg.operations;
  if (ops && typeof ops === "object") {
    return ops as OperationRegistryEntry;
  }
  return reg as unknown as OperationRegistryEntry;
}

export function getOperation(operation: string): OperationRegistryEntry[string] | undefined {
  return getOperations()[operation];
}

export function isMutation(operation: string): boolean {
  return getOperations()[operation]?.mutation ?? false;
}

export function requiresIdempotencyKey(operation: string): boolean {
  return getOperations()[operation]?.requiresIdempotencyKey ?? false;
}

export function getHttpVerb(operation: string): string | undefined {
  return getOperations()[operation]?.httpMethod;
}

export function getHttpPath(operation: string): string | undefined {
  return getOperations()[operation]?.httpPath;
}

export function isKnownOperation(operation: string): boolean {
  return operation in getOperations();
}
