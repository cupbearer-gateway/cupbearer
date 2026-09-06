# API

Loopback-only, no auth (the bind address is the security boundary — see [architecture.md](architecture.md)).

## OpenAI surface

### `GET /v1/models`

Every pool, as a model:

```json
{ "object": "list", "data": [{ "id": "smart", "object": "model", "owned_by": "cupbearer",
  "cupbearer": { "name": "Smart", "legs": ["groq/llama-3.3-70b-versatile", "gemini/gemini-flash-latest"] } }] }
```

### `POST /v1/chat/completions`

Standard OpenAI request. `model` is a **pool id** (routing through every leg) or an explicit `providerId/model` escape hatch that bypasses pool routing.

Response headers — the routing receipt:

- `x-cupbearer-provider` — which provider served
- `x-cupbearer-model` — which model served
- `x-cupbearer-attempts` — how many legs/keys were tried

Streaming (`"stream": true`) is real SSE passthrough with usage and finish reasons observed for metrics.

Failure semantics: `503` means "transient — worth retrying" (rate limits, timeouts); `502` means "misconfigured/exhausted pool — retrying changes nothing". The error body carries an `attempts` array with the per-leg reason, and `reason` for request-scoped verdicts (`context_too_long`, `content_filtered`, `quality_gate_failed`, `request_budget_exceeded`).

## Anthropic-compatible surface

### `POST /v1/messages`

The Anthropic Messages API on the same router: `system`, text/image content blocks, `tools`, `tool_use`/`tool_result` round trips, `stop_reason` and usage mapping. `stream: true` replays the completed result as the standard Anthropic SSE event sequence (`message_start` → `content_block_*` → `message_delta` → `message_stop`) — correct, but without streaming's time-to-first-byte benefit.

Model names resolve in order: configured pool id → `providerId/model` → **first configured pool** (so `claude-*` names from clients like Claude Code just work; the response discloses the fallback in `cupbearer_note`).

## Health & quality

- `GET /healthz` — `{ok, pools, providers, uptimeSeconds}`
- `GET /api/quality/decisions?limit=150&pool=<id>` — recent gate decisions (score, threshold, breakdown, judge verdict, downgrade flags)
- `GET /api/quality/summary?window=<ms>&pool=<id>` — aggregate evidence: decisions, held, blocked & rerouted, avg score, top failure reasons

## Dashboard API

- `GET /api/overview` — pools, providers (keys masked), quirks, stats, settings, canary status
- `GET|POST /api/pools`, `GET|PUT|DELETE /api/pools/:id`, `GET /api/pools/:id/detail` (series + live feed)
- `GET|POST /api/providers`, `GET|PUT|DELETE /api/providers/:id`
- `POST /api/providers/:id/keys` · `POST .../keys/bulk` · `PUT|DELETE .../keys/:keyId`
- `POST .../keys/:keyId/test` (1-token live probe) · `POST .../keys/:keyId/clear` (return to rotation)
- `GET .../keys/:keyId/value` — the single reveal endpoint; page loads only ever see masks
- `POST /api/providers/:id/discover` — refresh the model list from the provider's `/v1/models`
- `GET|PUT /api/settings` — validated settings (unknown keys rejected)
- `POST /api/rotation/restart` — clear sticky states + rotation cursors
- `POST /api/revive/run` · `POST /api/canary/run` · `GET /api/canary/status`
- `GET /api/feed?limit=&pool=` — newest calls
- `GET /api/events` — SSE: `attempt`, `success`, `failure`, `gate`, `pools`, `providers`, `settings`

Key values are **write-only** through this API: they go in via POST/PUT and come back only as masks. A replaced key gets a clean health slate.

## Quirks

Providers carry a `quirks` array; unknown ids are rejected at write time. `GET /api/overview` lists the registry. See [quirks.md](quirks.md) for the hook interface and the catalog.
