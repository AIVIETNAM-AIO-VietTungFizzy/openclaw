import crypto from "node:crypto";
import { Type } from "typebox";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const log = createSubsystemLogger("agents/receive-async-result");

const SESSION_KEY_PREFIX = "sk:";

export function buildCorrelationId(sessionKey: string): string {
  return `${SESSION_KEY_PREFIX}${sessionKey}::${crypto.randomUUID()}`;
}

function parseCorrelationId(correlationId: string): { sessionKey: string } | null {
  if (!correlationId.startsWith(SESSION_KEY_PREFIX)) return null;
  const rest = correlationId.slice(SESSION_KEY_PREFIX.length);
  const sep = rest.indexOf("::");
  if (sep === -1) return null;
  return { sessionKey: rest.slice(0, sep) };
}

const ReceiveAsyncResultSchema = Type.Object(
  {
    correlation_id: Type.String({ minLength: 1 }),
    result: Type.Any(),
  },
  { additionalProperties: false },
);

export function createReceiveAsyncResultTool(): AnyAgentTool {
  return {
    label: "Receive Async Result",
    name: "receive_async_result",
    displaySummary: "Receive async result from external service callback.",
    description:
      "Receives an async result from an external service (e.g. DeerFlow) and delivers it to the waiting session.",
    parameters: ReceiveAsyncResultSchema,
    execute: async (_toolCallId, args) => {
      if (!args || typeof args !== "object") {
        throw new ToolInputError("receive_async_result arguments required");
      }
      const params = args as Record<string, unknown>;
      const correlationId = params.correlation_id;
      if (typeof correlationId !== "string" || !correlationId) {
        throw new ToolInputError("correlation_id required");
      }
      const parsed = parseCorrelationId(correlationId);
      if (!parsed) {
        log.warn("received async result with unparseable correlation_id", { correlationId });
        return jsonResult({ status: "ignored", reason: "unparseable correlation_id" });
      }
      try {
        await callGateway({
          method: "send",
          params: {
            to: parsed.sessionKey,
            message: `Async research result received:\n\`\`\`json\n${JSON.stringify(params.result, null, 2)}\n\`\`\``,
          },
          timeoutMs: 10_000,
        });
        return jsonResult({ status: "delivered", correlation_id: correlationId });
      } catch (err) {
        log.warn("failed to deliver async result to session", {
          correlationId,
          sessionKey: parsed.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({ status: "delivery_failed", correlation_id: correlationId });
      }
    },
  };
}
