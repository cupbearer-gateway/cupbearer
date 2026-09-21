# Operations

## Running

```bash
npx cupbearer setup   # once: providers, keys, starter pool
npx cupbearer serve   # the gateway (or: npm start)
npx cupbearer doctor  # config + keys sanity; add --probe for 1-token live calls
```

Everything lives under one home directory (default `~/.config/cupbearer`, override with `CUPBEARER_HOME`):

```
config.json          pools + providers + settings — no secrets, safe to diff/share
secrets.json         key values, keyed by key id (ACL-locked to your user on Windows, chmod 600 elsewhere)
health-state.json    sticky key-health persistence
metrics/cupbearer.db SQLite request log + quality evidence
logs/boot.log        boot trace
dist/                dashboard bundle (in the app dir, not here — see paths.js)
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CUPBEARER_PORT` | `4143` | gateway port (4141/4142 deliberately avoided) |
| `CUPBEARER_HOST` | `127.0.0.1` | bind address; non-loopback requires `CUPBEARER_ALLOW_LAN=1` |
| `CUPBEARER_HOME` | `~/.config/cupbearer` | state directory |
| `CUPBEARER_UI_DIST` | `<app>/dist` | dashboard bundle override |
| `CUPBEARER_ALLOW_LAN` | unset | must be `1` to bind anything but loopback |

Keys may also come from the environment or a `.env` file (`.env` in the working directory is read by the setup wizard; `GROQ_API_KEY`, `GEMINI_API_KEY`, …) — the wizard offers them as defaults and stores what it uses in `secrets.json`.

## Settings reference (all validated; unknown keys rejected)

| Setting | Default | Meaning |
|---|---|---|
| `cooldownBaseSeconds` / `cooldownMaxSeconds` | 20 / 600 | rate-limit backoff window (exponential) |
| `deadAfterFailures` | 3 | consecutive total non-responses before a key is `dead` |
| `errorPullAfterFailures` | 3 | consecutive 5xx/408s before a key is pulled |
| `legRetries` | 1 | immediate same-provider retries on a transient upstream error (5xx/timeout) before failing over |
| `maxKeysPerLeg` | 8 | keys tried per provider per request |
| `attemptTimeoutMs` / `requestBudgetMs` | 90000 / 180000 | per-attempt and whole-request ceilings |
| `firstChunkTimeoutMs` / `chunkTimeoutMs` | 30000 / 60000 | stream waits (pre-commit / mid-stream) |
| `reviveProbe` / `reviveIntervalMinutes` / `reviveMaxPerTick` | true / 5 / 20 | background re-probe of pulled keys |
| `reviveSoonMs` | 20000 | fast lane: re-probe a key/route this soon after it is pulled, backing off up to the sweep interval |
| `canaryEnabled` / `canaryIntervalMinutes` | false / 15 | quiet probing of healthy keys |
| `notifyFailover` / `notifyCooldownMinutes` | true / 2 | Windows toasts on failover (per-source cooldown) |
| `metricsRetainDays` | 14 | SQLite log retention |
| `defaultQualityMode` | `off` | pool default when `qualityGate.mode` is unset |
| `gateTimeoutMs` | 30000 | cap on buffered gate waits and judge calls |

## Desktop notifications

Windows toasts fire when the router is forced to act — a key pulled (rate limit ceiling, out of quota, rejected), a provider switch, a pool going fully down, and when a dropped provider comes back. Routine rotation inside a provider stays silent on purpose. `notifyCooldownMinutes: 0` means every event toasts (a 2s global gap still applies); `notifyFailover: false` disables them.

The toast is shown by `scripts/toast.ps1` (pure PowerShell + WinRT, no modules). It maintains its own Start Menu shortcut (`Cupbearer Notifications.lnk`) so Windows has an app identity to attribute the toast to, and embeds the seal logo (`ui/public/cupbearer-toast.png`) directly in the payload. Regenerate brand assets with `scripts/make-toast.ps1` (toast PNG) and `scripts/make-ico.ps1` (the multi-size .ico). Test from the dashboard (Operations → Send test toast) or `POST /api/notify/test`.

## Auto-revival & background probes

Pulled keys come back on their own:

- **Fast lane** — the moment a key or (key, model) route is pulled, a re-probe is scheduled `reviveSoonMs` later (default 20s) with the exact model that failed. A success returns it to rotation with a "Provider is back" toast; a failure backs off (doubling) up to the sweep interval.
- **Slow sweep** — every `reviveIntervalMinutes` (default 5), `POST /api/revive/run`-style probing walks every still-pulled key/route once (`reviveMaxPerTick` per pass).
- **Canary** (`canaryEnabled`, off by default) quietly probes a few healthy keys so a silently dying provider is noticed before the next real request finds it.

`POST /api/rotation/restart` is the manual counterpart: it returns every key and route to rotation (including cooldowns and degraded streaks), resets rotation cursors, and reports `{ok, keys, routes}` — the next request starts from every pool's first provider again.

## Quality gate in practice

1. Start in **shadow** mode (the wizard default): `qualityGate: { mode: "shadow", threshold: 0.8 }`. Serve everything, log every score, watch the Quality view.
2. When the evidence convinces you, switch to **`gate`**: downgrades that fail are blocked pre-commit and rerouted to a stronger leg. First-choice legs are never gated, so normal latency is untouched.
3. Optional judge: `qualityGate: { mode: "gate", judge: { "providerId": "groq", "model": "llama-3.3-70b-versatile" } }` — runs on your own keys; heuristics remain half the score. Judge failures are non-fatal.
4. `maxDowngrades` (default 2) caps how many gated attempts may fail before the request stops with `quality_gate_failed` instead of burning every remaining leg.

Recommended pool shape for free-tier pooling: cheap leg **first** (undeclared tier), stronger backup second, gate on. Small tasks sail through ungated; anything the profiler marks flagship is a downgrade and gets verified.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `unknown model "x"` | pool ids are model names | `GET /v1/models`; or use `providerId/model` |
| `all_keys_unusable` on a leg | every key sticky (exhausted/dead/rejected) | fix or top up the key, then `POST /api/rotation/restart` or edit the key in the dashboard |
| key stuck `cooling` | upstream rate limiting | wait out the backoff; it self-heals |
| `quality_gate_failed` | every reachable leg scored below the threshold | shadow-mode evidence shows why; raise/lower `threshold`, widen tiers, or switch mode |
| 502 vs 503 | 502 = misconfigured/exhausted, 503 = transient | the `attempts` array in the error body names the per-leg reasons |
| dashboard blank | bundle not built | `npm run build` (repo) — API still works |
| port taken | another instance | `CUPBEARER_PORT=…` |
| Claude Code gets no models | nothing configured | `cupbearer setup`; unknown model names fall back to the first pool |

## Backup / restore

Copy the home directory (stop the gateway first or accept a torn SQLite WAL): `config.json`, `secrets.json`, `metrics/` are the state; everything else is rebuildable.

## Tests & smoke

```bash
npm test      # 254 unit tests, no keys needed
npm run smoke # boots stub upstreams + the real gateway, pushes traffic through failover + streaming
```
