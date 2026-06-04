# paperclip-contract (bundled OpenClaw plugin)

Governs Paperclip Layer 4B operations behind a frozen contract — **request, response,
error, retry, idempotency** — and a **trusted tool policy** that runs before every
ordinary `before_tool_call` hook (bundled-only; that is why this ships inside the image).

## What it registers

- **Tool** `paperclip_contract_call` — the single governed entry point. Validates the
  envelope, classifies risk, enforces idempotency (replay / conflict / pending /
  unknown-state), retries per the frozen matrix, and returns the normalized response.
- **Trusted tool policy** `paperclip-contract-policy` — hard-blocks raw
  `exec/process/browser/nodes` and direct `paperclip.*` sub-tools, and approval-gates
  approval-class operations (`complete_work_item`) before execution.

## Layout

```
index.ts                 # definePluginEntry → registerTool + registerTrustedToolPolicy
openclaw.plugin.json     # manifest (id, configSchema, contracts.tools)
src/                     # SDK-agnostic contract logic (facade/guard/retry/idempotency/client/...)
contracts/               # frozen contract JSON (inlined via `import ... with { type: "json" }`)
```

The `src/` logic is the same code unit-tested in the AIautomation repo
(`runtime-core/shared/paperclip-openclaw-contract/`, 263 vitest tests). Here the JSON
loaders use static imports (bundler-inlined; no runtime `fs`) so they survive bundling.

## Config (env-first)

| Env var                | Purpose                                               | Default                    |
| ---------------------- | ----------------------------------------------------- | -------------------------- |
| `PAPERCLIP_BASE_URL`   | Paperclip 4B server base URL                          | `http://paperclip-4b:8080` |
| `PAPERCLIP_TARGET_ENV` | Scopes the idempotency request-hash to an environment | base URL host              |

## Build into a custom image

From the openclaw repo root:

```bash
pnpm install
docker build --build-arg OPENCLAW_EXTENSIONS="paperclip-contract" \
  -t <your-registry>/openclaw:paperclip .
docker push <your-registry>/openclaw:paperclip
```

Then point the AIautomation stack at it by setting `OPENCLAW_IMAGE` (the compose files
already read `${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}`):

```bash
# in the AIautomation deploy env / .env
OPENCLAW_IMAGE=<your-registry>/openclaw:paperclip
```

## Verify at runtime

```bash
openclaw plugins inspect paperclip-contract --runtime --json   # tool + trusted policy registered
```

Then drive an agent: a raw `exec`/`browser` call is blocked before execution;
`complete_work_item` raises an approval prompt (timeout → deny); a duplicated
`idempotencyKey` replays instead of re-POSTing; a 503 retries on `[1s,3s,10s]`;
a 500 (`UPSTREAM_FAILED`) does not retry.
