# Changelog

All notable changes to Cupbearer are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

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
