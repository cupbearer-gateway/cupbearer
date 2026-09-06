# Architecture

Cupbearer is one Node process, one port, zero runtime dependencies. It serves:

- `/v1/*` — the OpenAI-compatible surface (and `/v1/messages`, Anthropic-compatible)
- `/api/*` — dashboard REST + SSE
- `/` — the prebuilt dashboard bundle from `dist/`

**Security boundary: the loopback bind.** The process holds every upstream API key and performs no HTTP authentication. It binds `127.0.0.1` and refuses to start on a non-loopback host unless `CUPBEARER_ALLOW_LAN=1` is set explicitly. Do not run it on an untrusted network.

## Module map

| Module | Role |
|---|---|
| `server/index.js` | bootstrap: routes, static serving, graceful shutdown, boot log |
| `server/paths.js` | every disk location + `CUPBEARER_PORT` / `CUPBEARER_HOST` / `CUPBEARER_HOME` |
| `server/config.js` | config store (pools/providers/settings), atomic writes, strict validation |
| `server/secrets.js` | key values in a separate ACL-locked file; write-only through the API, masked in reads |
| `server/openai-surface.js` | `GET /v1/models`, `POST /v1/chat/completions` |
| `server/anthropic-surface.js` | `POST /v1/messages` (Anthropic Messages API translation) |
| `server/router.js` | the heart: profile → tier-ordered plan → leg/key walk → failover |
| `server/profile.js` | request profiler → required tier + capabilities (heuristic, $0) |
| `server/upstream.js` | one outbound call; **never writes to the client** |
| `server/relay.js` | SSE relay with deferred commit, stream translators, buffered mode |
| `server/classify.js` | error classifier → `{reason, keyState, scope, retry}` verdicts |
| `server/health.js` | key health state machine (healthy/cooling/degraded/exhausted/auth_failed/dead) |
| `server/quality/` | evaluators (heuristics), judge (optional LLM), gate (modes + evidence) |
| `server/store.js` | SQLite (node:sqlite) request log + decision evidence |
| `server/metrics.js` | in-memory rolling window over the store; dashboard stats |
| `server/quirks/` | per-provider request/response/stream shims (registry + 10 quirks) |
| `server/presets.js` | BYOK provider presets for the setup wizard |
| `server/events.js` | in-process event bus + SSE fan-out for the dashboard |
| `server/notify.js` · `revive.js` · `canary.js` | toasts, sticky-key revival, healthy-key canary |

## Request lifecycle

```
POST /v1/chat/completions
  │  openai-surface: parse, resolve model → pool (or providerId/model escape hatch)
  ▼
profile.js          tools/images/size → { requiredTier, capabilities }
  ▼
router.dispatch
  ├─ orderLegs      capability filter → cheapest sufficient tier first;
  │                 tiers-undeclared pools keep declared order (downgrade = tier > required)
  ├─ per (leg, key) attempt:
  │    upstream.callJson / openStream      (quirks applied; nothing written yet)
  │    ├─ pre-commit failure → classify verdict → retry key / leg / stop
  │    ├─ downgrade + gate mode → relay buffers full response → quality gate
  │    │    pass → commit        fail → next stronger leg (evidence logged)
  │    └─ pass/first-choice → commit & stream through
  ▼
store.js (SQLite): request rows, attempt rows, gate decisions
events → dashboard SSE (attempt/success/failure/gate/…)
```

### The deferred-commit failover contract

An attempt may only be abandoned **before any byte reaches the client**. Once output is flushed, switching providers would splice two responses together, so a mid-stream failure is reported as an SSE error instead of retried. In practice almost everything relevant (401/402/429/5xx, stalls, dead streams before first byte) arrives pre-commit.

The mechanism: `upstream.js` never writes; `relay.js` defers response headers until the first flushed byte (`onFirstByte`); stream translators that buffer tool calls can still reject a response at end-of-stream with nothing written. The quality gate reuses exactly this property — a buffered downgrade is just another abandonable attempt.

### Time budgets

One clock per request (`requestBudgetMs`, default 180s), each attempt clamped to what remains (`attemptTimeoutMs`, 90s), plus separate first-chunk (30s) and in-stream (60s) waits. Once the remainder is too small to be worth an attempt, the request stops with `request_budget_exceeded` instead of burning a key's quota on a guaranteed failure. Pools may override per pool; providers per provider.

## Key health

State is derived from real traffic, not probing: `healthy → cooling` (rate limits, exponential backoff) `→ degraded` (5xx streaks) `→ exhausted / auth_failed / dead` (sticky, pulled from rotation). Sticky states persist to `health-state.json` with TTLs and are cleared by the dashboard, an edited key, or the `revive` probe when the upstream starts answering again. Deliberately not tracked: currency balances — `exhausted` is inferred from what the upstream actually says.

## Storage

`node:sqlite` (built into Node ≥ 22 — zero native dependencies): `requests` (one row per completed call, attempts as JSON), `decisions` (quality/route evidence: score, threshold, breakdown, judge verdict, downgrade flags). WAL mode; writes batched off the request path; retention via `storeRetainDays`.

## State ownership

| State | Lives in | Survives restart |
|---|---|---|
| config (pools/providers/settings) | `config.json` | yes |
| key values | `secrets.json` (ACL-locked) | yes |
| sticky key health | `health-state.json` + memory | yes (TTL) |
| live health stats | memory (rebuilt from traffic) | no |
| request log + gate evidence | SQLite `metrics/cupbearer.db` | yes |
| rotation cursors | memory | no (by design) |
