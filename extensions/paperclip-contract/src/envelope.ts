import { z } from "zod";
import type { Caller, ContractEnvelope, SuccessResponse, ErrorResponse } from "./types.js";
import {
  CallerSchema,
  ContractEnvelopeSchema,
  SuccessResponseSchema,
  ErrorResponseSchema,
} from "./types.js";

export type { Caller, ContractEnvelope, SuccessResponse, ErrorResponse };
export { CallerSchema, ContractEnvelopeSchema, SuccessResponseSchema, ErrorResponseSchema };

// ─── Serialize / Deserialize ────────────────────────────────────────────────────

export function serializeEnvelope(envelope: ContractEnvelope): string {
  return JSON.stringify(envelope);
}

export function deserializeEnvelope(json: string): ContractEnvelope {
  return ContractEnvelopeSchema.parse(JSON.parse(json));
}

export function serializeSuccessResponse(response: SuccessResponse): string {
  return JSON.stringify(response);
}

export function deserializeSuccessResponse(json: string): SuccessResponse {
  return SuccessResponseSchema.parse(JSON.parse(json));
}

export function serializeErrorResponse(response: ErrorResponse): string {
  return JSON.stringify(response);
}

export function deserializeErrorResponse(json: string): ErrorResponse {
  return ErrorResponseSchema.parse(JSON.parse(json));
}
