// Gateway Protocol tests cover agent behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./agent.js";

/**
 * Regression coverage for agent-run schema payloads that carry internal
 * completion events. These events are produced by child automation and consumed
 * by parent agent runs, so the fixture mirrors the cross-runtime boundary.
 */
type AgentInternalEvent = {
  type: "task_completion";
  source: string;
  childSessionKey: string;
  childSessionId: string;
  announceType: string;
  taskLabel: string;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: unknown[];
  mediaUrls?: string[];
  replyInstruction?: string;
};

/** Builds the smallest valid agent request that embeds one internal event. */
function makeAgentParamsWithInternalEvent(event: AgentInternalEvent) {
  return {
    message: "A music generation task finished. Process the completion update now.",
    sessionKey: "agent:main:discord:channel:1456744319972282449",
    internalEvents: [event],
    idempotencyKey: "music_generate:task-123:ok",
  };
}

/** Representative generated-media completion event from a child task. */
const musicCompletionEvent: AgentInternalEvent = {
  type: "task_completion",
  source: "music_generation",
  childSessionKey: "music_generate:task-123",
  childSessionId: "task-123",
  announceType: "music generation task",
  taskLabel: "OpenClaw release anthem",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 track.",
  attachments: [
    {
      type: "audio",
      path: "/tmp/openclaw/generated-release-anthem.mp3",
      mimeType: "audio/mpeg",
      name: "generated-release-anthem.mp3",
    },
  ],
  mediaUrls: ["/tmp/openclaw/generated-release-anthem.mp3"],
  replyInstruction: "Deliver the generated music.",
};

describe("AgentParamsSchema", () => {
  it("accepts generated music attachments on internal completion events", () => {
    const params = makeAgentParamsWithInternalEvent(musicCompletionEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("keeps task completion internal events strict", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      unexpected: true,
    } as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("rejects malformed generated attachment entries on internal events", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      attachments: [null],
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });
});

describe("AgentParamsSchema — paperclip dispatch payload (gap 1.5)", () => {
  const base = {
    message: "Work on issue-9.",
    sessionKey: "agent:main:paperclip:issue:issue-9",
    idempotencyKey: "run-777",
  };

  it("accepts an optional paperclip payload object (Layer 4B dispatch context)", () => {
    const params = {
      ...base,
      paperclip: {
        runId: "run-777",
        issueId: "issue-9",
        envelope: {
          trace_id: "run-777",
          tenant_id: "ten-1",
          company_id: "co-1",
          employee_id: "emp-1",
          package: "L2",
          role: "finance_staff",
          locale: "vi-VN",
          timezone: "Asia/Ho_Chi_Minh",
          issue_id: "issue-9",
          task_id: null,
        },
      },
    };
    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("still accepts requests without a paperclip payload (back-compat)", () => {
    expect(Value.Check(AgentParamsSchema, base)).toBe(true);
  });

  it("rejects a non-object paperclip payload", () => {
    expect(Value.Check(AgentParamsSchema, { ...base, paperclip: "yes" })).toBe(false);
  });
});
