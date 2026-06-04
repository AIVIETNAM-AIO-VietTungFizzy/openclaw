import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it } from "vitest";
import paperclipPlugin from "./index.js";

// ─── Tier-1 host test ─────────────────────────────────────────────────────────
// Validates the real SDK wiring of index.ts (definePluginEntry → registerTool +
// registerTrustedToolPolicy) against the official `createTestPluginApi` harness —
// the one surface the runtime-core vitest suite (263 tests) cannot cover. The deep
// retry/idempotency matrix lives there; here we prove registration shape, the
// trusted-policy decision branches, and the AgentToolResult contract end-to-end.

type RegisteredTool = Parameters<OpenClawPluginApi["registerTool"]>[0];
type RegisteredPolicy = Parameters<OpenClawPluginApi["registerTrustedToolPolicy"]>[0];

const FACADE_TOOL = "paperclip_contract_call";
const POLICY_ID = "paperclip-contract-policy";

// ─── Minimal in-process Paperclip 4B stub ─────────────────────────────────────
function startMockPaperclip(opts: { upstreamError?: boolean } = {}) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (/^\/api\/companies\/[^/]+\/issues$/.test(url.pathname) && req.method === "GET") {
      hits += 1;
      json(200, [{ id: "wi-001", status: "ready" }]);
      return;
    }
    const complete = url.pathname.match(/^\/api\/issues\/([^/]+)\/work-products$/);
    if (complete && req.method === "POST") {
      hits += 1;
      if (opts.upstreamError) {
        json(500, { error: "internal error" });
        return;
      }
      json(200, { id: complete[1], status: "completed" });
      return;
    }
    json(404, { error: "not found" });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { port, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "2026-05-28",
    requestId: "req-" + Math.random().toString(36).slice(2),
    operation: "paperclip.ready_work",
    traceId: "trace-" + Math.random().toString(36).slice(2),
    caller: {
      agentId: "agent-001",
      sessionKey: "sess-001",
      tenantId: "tenant-001",
      companyId: "company-001",
      employeeId: "emp-001",
      package: "L1",
      runtimeLane: "7A",
    },
    params: {},
    ...overrides,
  };
}

// Register the plugin via the official harness and capture what it registers.
// readConfig() reads PAPERCLIP_BASE_URL at register time, so callers set the env
// (pointing at a mock) BEFORE invoking this.
function register(config: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  const policies: RegisteredPolicy[] = [];
  paperclipPlugin.register?.(
    createTestPluginApi({
      id: "paperclip-contract",
      name: "Paperclip Contract",
      config,
      registerTool: (tool) => tools.push(tool),
      registerTrustedToolPolicy: (policy) => policies.push(policy),
    }),
  );
  return { tools, policies };
}

type AnyEvent = Parameters<RegisteredPolicy["evaluate"]>[0];
const evt = (toolName: string, params: Record<string, unknown> = {}): AnyEvent =>
  ({ toolName, params }) as unknown as AnyEvent;

const prevBaseUrl = process.env.PAPERCLIP_BASE_URL;
afterEach(() => {
  if (prevBaseUrl === undefined) delete process.env.PAPERCLIP_BASE_URL;
  else process.env.PAPERCLIP_BASE_URL = prevBaseUrl;
});

describe("paperclip-contract plugin: SDK registration", () => {
  it("registers exactly the facade tool and the trusted policy", () => {
    const { tools, policies } = register();
    expect(tools.map((t) => t.name)).toEqual([FACADE_TOOL]);
    expect(policies.map((p) => p.id)).toEqual([POLICY_ID]);
    expect(typeof tools[0].execute).toBe("function");
    expect(typeof policies[0].evaluate).toBe("function");
  });
});

describe("paperclip-contract trusted policy: evaluate() decisions", () => {
  it("hard-blocks raw bypass tools", async () => {
    const { policies } = register();
    for (const raw of ["exec", "browser", "nodes", "process"]) {
      const decision = await policies[0].evaluate(evt(raw));
      expect(decision).toMatchObject({ block: true });
    }
  });

  it("passes a free read operation through (no block, no approval)", async () => {
    const { policies } = register();
    const decision = await policies[0].evaluate(
      evt(FACADE_TOOL, { envelope: { operation: "paperclip.ready_work" } }),
    );
    expect(decision).not.toMatchObject({ block: true });
    expect((decision as { requireApproval?: unknown }).requireApproval).toBeUndefined();
  });

  it("approval-gates an approval-class mutation with deny-on-timeout", async () => {
    const { policies } = register();
    const decision = await policies[0].evaluate(
      evt(FACADE_TOOL, { envelope: { operation: "paperclip.complete_work_item" } }),
    );
    const approval = (decision as { requireApproval?: Record<string, unknown> }).requireApproval;
    expect(approval).toBeDefined();
    expect(approval?.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(approval?.timeoutBehavior).toBe("deny");
  });

  it("blocks an unknown operation", async () => {
    const { policies } = register();
    const decision = await policies[0].evaluate(
      evt(FACADE_TOOL, { envelope: { operation: "paperclip.unknown_op" } }),
    );
    expect(decision).toMatchObject({ block: true });
  });
});

describe("paperclip-contract facade tool: execute() contract", () => {
  it("returns a well-formed AgentToolResult on a successful read", async () => {
    const mock = startMockPaperclip();
    process.env.PAPERCLIP_BASE_URL = `http://localhost:${mock.port}`;
    try {
      const { tools } = register();
      const result = await tools[0].execute!("tc-1", { envelope: envelope() });
      expect(result.content[0]).toMatchObject({ type: "text" });
      const body = result.details as { ok: boolean; operation: string };
      expect(body.ok).toBe(true);
      expect(body.operation).toBe("paperclip.ready_work");
    } finally {
      await mock.close();
    }
  });

  it("replays a duplicated idempotencyKey instead of re-POSTing", async () => {
    const mock = startMockPaperclip();
    process.env.PAPERCLIP_BASE_URL = `http://localhost:${mock.port}`;
    try {
      const { tools } = register();
      const env = envelope({
        operation: "paperclip.complete_work_item",
        idempotencyKey: "idem-replay",
        params: { id: "wi-001" },
      });
      const first = (await tools[0].execute!("tc-1", { envelope: env })).details as { ok: boolean };
      const second = (await tools[0].execute!("tc-2", { envelope: env })).details as {
        ok: boolean;
      };
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(mock.hits()).toBe(1); // second call replayed from the store
    } finally {
      await mock.close();
    }
  });

  it("maps a 500 to UPSTREAM_FAILED and does NOT retry", async () => {
    const mock = startMockPaperclip({ upstreamError: true });
    process.env.PAPERCLIP_BASE_URL = `http://localhost:${mock.port}`;
    try {
      const { tools } = register();
      const env = envelope({
        operation: "paperclip.complete_work_item",
        idempotencyKey: "idem-500",
        params: { id: "wi-001" },
      });
      const body = (await tools[0].execute!("tc-1", { envelope: env })).details as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("UPSTREAM_FAILED");
      expect(mock.hits()).toBe(1); // non-retryable: a single upstream attempt
    } finally {
      await mock.close();
    }
  });
});

// ─── Control-plane Policy Guard path ──────────────────────────────────────────
// When policyGuardUrl + identity are configured, the trusted policy delegates
// tool allow/deny/approval to the control-plane enforce() endpoint.
function startMockEnforce(decisionFor: (toolId: string) => Record<string, unknown>) {
  let lastBody: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastBody = JSON.parse(data || "{}");
      const decision = decisionFor(String(lastBody!.tool_id ?? ""));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ trace_id: "trace-test", ...decision }));
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/api/core/enforce`,
    lastBody: () => lastBody,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const policyConfig = (url: string, extra: Record<string, unknown> = {}) => ({
  policyGuardUrl: url,
  serviceToken: "test-token",
  tenantId: "ten-1",
  employeeId: "emp-1",
  package: "L1",
  cacheTtlMs: 0, // disable caching so each evaluate hits the mock
  ...extra,
});

describe("paperclip-contract trusted policy: control-plane enforce()", () => {
  it("deny → blocks, and sends a well-formed enforce request", async () => {
    const enf = startMockEnforce(() => ({
      decision: "deny",
      deny_reason: "package_not_allowed_for_tool",
    }));
    try {
      const { policies } = register(policyConfig(enf.url));
      const decision = await policies[0].evaluate(evt("web_fetch"));
      expect(decision).toMatchObject({ block: true });
      expect(enf.lastBody()).toMatchObject({
        tool_id: "web_fetch",
        package: "L1",
        intent_kind: "tool",
        caller_service: "openclaw",
        tenant_id: "ten-1",
        employee_id: "emp-1",
      });
    } finally {
      await enf.close();
    }
  });

  it("allow → passes a non-facade tool through", async () => {
    const enf = startMockEnforce(() => ({ decision: "allow" }));
    try {
      const { policies } = register(policyConfig(enf.url));
      const decision = await policies[0].evaluate(evt("web_fetch"));
      expect(decision).not.toMatchObject({ block: true });
      expect((decision as { requireApproval?: unknown }).requireApproval).toBeUndefined();
    } finally {
      await enf.close();
    }
  });

  it("require_approval → surfaces an approval prompt with deny-on-timeout", async () => {
    const enf = startMockEnforce(() => ({
      decision: "require_approval",
      approval_class: "A2",
      sla_seconds: 900,
    }));
    try {
      const { policies } = register(policyConfig(enf.url));
      const decision = (await policies[0].evaluate(evt("exec"))) as {
        requireApproval?: Record<string, unknown>;
      };
      expect(decision.requireApproval).toBeDefined();
      expect(decision.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
      expect(decision.requireApproval?.timeoutBehavior).toBe("deny");
    } finally {
      await enf.close();
    }
  });

  it("fails CLOSED (block) when the control plane is unreachable", async () => {
    const { policies } = register(
      policyConfig("http://127.0.0.1:1/api/core/enforce", { failMode: "deny" }),
    );
    const decision = await policies[0].evaluate(evt("exec"));
    expect(decision).toMatchObject({ block: true });
  });

  it("allowed facade tool still applies operation-level approval", async () => {
    const enf = startMockEnforce(() => ({ decision: "allow" }));
    try {
      const { policies } = register(policyConfig(enf.url));
      const decision = (await policies[0].evaluate(
        evt(FACADE_TOOL, { envelope: { operation: "paperclip.complete_work_item" } }),
      )) as { requireApproval?: unknown };
      expect(decision.requireApproval).toBeDefined();
    } finally {
      await enf.close();
    }
  });
});
