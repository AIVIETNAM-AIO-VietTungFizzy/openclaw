import { describe, expect, it } from "vitest";
import { buildEnforcePayload, SessionEnvelopeSchema } from "./session-envelope.js";

const base = {
  tenantId: "ten-1",
  employeeId: "emp-1",
  package: "L1",
  role: "agent",
  callerService: "openclaw",
  callerVersion: "1.0.0",
};

describe("session-envelope", () => {
  it("builds a full V24 enforce payload with defaults", () => {
    const p = buildEnforcePayload(base, {
      toolId: "web_fetch",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(p).toMatchObject({
      tenant_id: "ten-1",
      employee_id: "emp-1",
      package: "L1",
      role: "agent",
      intent_kind: "tool",
      tool_id: "web_fetch",
      session_id: "11111111-1111-4111-8111-111111111111",
      caller_service: "openclaw",
      channel_used: "openclaw_gateway",
      agent_used: "openclaw:paperclip",
    });
    expect(typeof p.trace_id).toBe("string");
    expect(p.trace_root).toContain("ten-1");
    expect(p.trace_root).toContain("emp-1");
  });

  it("includes optional identity/locale/lane/cost fields when configured", () => {
    const p = buildEnforcePayload(
      {
        ...base,
        companyId: "company-1",
        locale: "vi-VN",
        timezone: "Asia/Ho_Chi_Minh",
        runtimeLane: "7A",
      },
      {
        toolId: "misa_post_voucher",
        sessionId: "11111111-1111-4111-8111-111111111111",
        estimatedCostUsd: 0.05,
        amount: 60_000_000,
        currency: "VND",
      },
    );
    expect(p).toMatchObject({
      company_id: "company-1",
      locale: "vi-VN",
      timezone: "Asia/Ho_Chi_Minh",
      runtime_lane: "7A",
      estimated_cost_usd: 0.05,
      amount: 60_000_000,
      currency: "VND",
    });
  });

  it("rejects a payload missing required identity (schema is the test gate)", () => {
    expect(() =>
      buildEnforcePayload({ ...base, tenantId: "" }, { toolId: "web_fetch", sessionId: "s" }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error — toolId is required
      buildEnforcePayload(base, { sessionId: "s" }),
    ).toThrow();
  });

  it("schema rejects invalid field types", () => {
    const good = buildEnforcePayload(base, { toolId: "t", sessionId: "s" });
    expect(SessionEnvelopeSchema.safeParse(good).success).toBe(true);
    expect(SessionEnvelopeSchema.safeParse({ ...good, estimated_cost_usd: "cheap" }).success).toBe(
      false,
    );
    expect(SessionEnvelopeSchema.safeParse({ ...good, tenant_id: 42 }).success).toBe(false);
  });
});
