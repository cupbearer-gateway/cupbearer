# Changelog

All notable changes to Cupbearer are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [0.2.0] — 2026-09-21

The failover-and-recovery overhaul: faster to fail over, faster to come back, and honest about why.

### Added
- Same-leg retry (`legRetries`, default 1): a transient upstream error (5xx / 408) is retried once on the same provider before the request fails over, absorbing per-second upstream flaps without paying the next leg's latency. `0` restores fail-first behavior.
- Fast-lane recovery (`reviveSoonMs`, default 20000): the moment a key or (key, model) route is pulled, a re-probe is scheduled ~20s out with the exact model that failed; a success returns it to rotation (with a "Provider is back" toast). Failed fast probes back off up to the sweep interval, where the periodic revive sweep takes over.
- `POST /api/rotation/restart` now returns what it cleared (`{keys, routes}`) and the dashboard says so; a no-op click is distinguishable from a real clear.

### Fixed
- **Restart rotation actually restarts rotation.** It cleared only sticky states — rate-limited (`cooling`) keys, the most common reason a first provider is skipped, stayed out of rotation for up to 10 minutes, so the next request still started at provider 2. Now every non-healthy state (cooling, degraded streaks, sticky pulls, model routes) returns to rotation.
- **Rotation cursors are per (provider, model).** One provider serving several legs of a pool with different models (agentrouter → deepseek AND glm) shared one cursor: the legs stole each other's starting offset within a single dispatch, and a failure on one model's leg reordered the other model's key rotation.
- **Dashboard leg health is model-aware.** Per-leg "n/m keys usable" counted keys pulled for that leg's exact model as usable; the dashboard now agrees with what the router will actually do. Pool key totals count distinct keys, so a provider on two legs is no longer double-counted.
- **Editing a pool no longer wipes leg `tier`/`capabilities`** (which silently disabled the quality gate and capability filtering for the whole pool).
- **`notifyCooldownMinutes: 0` means no cooldown** (it silently became 10 minutes). **"Keep call history" is honored** (the knob wrote `metricsRetainDays`; retention read `storeRetainDays`).
- **Toast icon**: regenerated `cupbearer-toast.png` at 256px with the seal filling the frame (`scripts/make-toast.ps1`, derived from the logo) and `hint-crop="none"` — the emblem no longer renders as a tiny/shrunken mark at toast scale.
- Cross-process test flake: test suites now run against an isolated `CUPBEARER_HOME` instead of racing the live gateway's health-state file.
- Hardened `serveStatic` path check against sibling-directory prefixes; provider deletion resets rotation cursors like other mutations.

### Dashboard
- Keys on multi-model providers get a test-model picker (a key can be fine for one model and out of quota for another); rate-limited keys expose a Reset button.
- Pools grid: one health segment per key (deduped across legs), "Edit legs" label on what opens the leg editor; cooling keys join the "out of rotation" banner; Stream shows plain-English failure reasons, the failover attempt count (×N), and the actual origin the client should point at.

## [0.1.2] — 2026-09-06

### Packaging
- npm registry release. No functional changes over 0.1.0 — the per-(key, model) health work and serving-leg model reporting landed on main directly ahead of 0.2.0.

## [0.1.1] — 2026-09-06

### Packaging
- npm registry release; version alignment only.

## [0.1.0] — 2026-09-06

The open-source rebuild of an internal gateway ("Conflux"). Public v1.

### Added
- Quality-verified routing: heuristic request profiler → required quality tier + capabilities; tier-aware leg ordering; quality gate (`off` / `shadow` / `gate`) with $0 evaluators (JSON validity, empty, refusal, repetition/looping, truncation, tool-arg validity) and an optional LLM-as-judge on the user's own keys. Failing gated downgrades reroute pre-commit; every decision logged as evidence.
- SQLite evidence store (`node:sqlite` — zero native dependencies): request log, per-attempt rows, gate decisions; `/api/quality/decisions` + `/api/quality/summary`.
- Anthropic-compatible `/v1/messages` surface (system, text/images, tools, tool_use/tool_result, streaming event replay) so Claude Code drops in via `ANTHROPIC_BASE_URL`.
- One-command experience: `cupbearer setup` (BYOK provider presets with 1-token key probes and live model discovery, cheap-first starter pool), `serve`, `doctor` (+ `--probe`).
- Benchmark report generator: fixed 6-task workload through the gateway's normal surface, deterministic checks, markdown + JSON output, honest cost accounting (`$0.00 spent` on free tiers; optional price table) and an explicit real-vs-stub run label.
- Dashboard: Quality view (live gate evidence feed + 24h aggregates), tier/capability fields, client-agnostic pool builder.
- Keyless end-to-end smoke test (bundled stub upstreams + real gateway) and a 238-test unit suite that runs on any machine.

### Carried over (rebuilt from the internal gateway)
- Deferred-commit failover router with request time budgets and the key/leg/request verdict contract.
- Key health state machine (cooling/degraded/exhausted/auth_failed/dead) with sticky-state persistence and background revival.
- The quirk subsystem: 10 provider-normalization shims with verbatim-payload tests.
- React dashboard shell, pools/providers/keys management, SSE live feed, Windows toast notifications.

### Removed (relative to the internal gateway)
- Client-config adapters (opencode/ZCode JSONC writers) and every hardcoded reference to personal clients, endpoints, and accounts.
- Hardcoded Groq audio-transcription endpoint and the local-file vision helper (roadmap: generalized multimodal passthrough).
- The internal seed script (it contained plaintext API keys) — replaced by presets + the setup wizard.
- JSONL call log — replaced by SQLite.

### Security
- Loopback-only bind enforced at boot; non-loopback requires explicit `CUPBEARER_ALLOW_LAN=1`.
- `secrets.json` ACL-locked to the current user; key values are write-only through the API (masked reads, single explicit reveal endpoint).
- No telemetry, no phone-home; benchmark runs stay on the user's machine.
