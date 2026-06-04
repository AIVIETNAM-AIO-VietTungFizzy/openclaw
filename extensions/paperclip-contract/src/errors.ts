// Static import: inlined by the bundler (no runtime fs read in the image).
import taxonomyData from "../contracts/paperclip-openclaw-error-taxonomy.v1.json" with { type: "json" };
import { ErrorCode, ErrorCategory, ErrorDetailSchema, ErrorResponseSchema } from "./types.js";

export { ErrorCode, ErrorCategory, ErrorDetailSchema, ErrorResponseSchema };

// ─── Taxonomy Lookup ──────────────────────────────────────────────────────────

interface TaxonomyEntry {
  category: string;
  retryable: boolean;
  description: string;
  handler: string;
}

interface ErrorTaxonomy {
  version: string;
  errorCodes: Record<string, TaxonomyEntry>;
}

export function loadTaxonomy(): ErrorTaxonomy {
  return taxonomyData as unknown as ErrorTaxonomy;
}

/** Look up a taxonomy entry by error code. */
export function lookupError(code: string): TaxonomyEntry | undefined {
  return loadTaxonomy().errorCodes[code];
}

/** True if the error code is retryable per the taxonomy. */
export function isRetryableError(code: string): boolean {
  return lookupError(code)?.retryable ?? false;
}

/** The error category for a given error code. */
export function getErrorCategory(code: string): string {
  return lookupError(code)?.category ?? "INTERNAL";
}
