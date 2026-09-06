# REVIEW.md — the Conflux → Cupbearer rebuild

**Status: all milestones (M1–M7) complete. Awaiting human review.**
Date: 2026-09-06 · 7 commits · 238/238 unit tests · keyless smoke green · benchmark dry run green · live instance at `~/.config/conflux` untouched (read-only throughout; `secrets.json` never opened).

---

## 1. What changed vs. the original

The original was already well-engineered; the rebuild's job was to make it shippable and to build the differentiator. Roughly: **70% ported & de-personalized, 30% new.**

### Kept (the proven core)
- **Deferred-commit failover router** — attempts are abandonable until the first flushed byte; `classify.js` verdicts decide key/leg/request scope; request time budgets prevent unbounded chains. The quality gate was designed *onto* this property.
- **Key health state machine** (cooling/degraded/exhausted/auth_failed/dead, exponential cooldowns, sticky persistence, revive/canary probes) and **key pooling/rotation** (round-robin, sticky-until-error, fastest-first).
- **The quirk subsystem** — 10 per-provider shims (schema sanitizers, thought signatures, XML tool-call repair, think-tag routing, …) with verbatim-payload tests. Unchanged except naming.
- **React dashboard shell** (pools/providers/keys CRUD, live SSE feed, hand-rolled design system) and Windows toast notifications.

### Removed (personal layer — never entered the repo)
- `scripts/seed.js` + `.bak` (contained **plaintext API keys, personal emails, spend figures**) — replaced by presets + guided setup.
- opencode/ZCode client adapters + the JSONC byte-surgeon writer (and their UI/API surface).
- Hardcoded Groq audio endpoint, local-file `/v1/vision` helper, hardcoded user paths, autostart `.bat`/`.vbs`, personal config/metrics/logs/secrets.

### Added (the product layer)
- **Request profiler** (`profile.js`) — heuristic, $0: tools/images/size → required tier (flagship/standard/light) + capabilities. Note: the brief assumed `classify.js` did this; it actually classifies *errors* — both exist now, with distinct docs.
- **Tiered routing** — cheapest-sufficient-first leg ordering; pools without tiers behave exactly as before.
- **Quality gate** (`quality/`) — off/shadow/gate modes; heuristic evaluators (JSON, empty, refusal, repetition, truncation, tool-args) + optional LLM-as-judge; a failing downgrade is just another pre-commit failover; `maxDowngrades` caps the burn; **every decision stored as evidence**.
- **SQLite evidence store** — request log + decisions via **`node:sqlite`** (zero native deps — a deliberate deviation from the plan's `better-sqlite3`, which the built-in module makes unnecessary).
- **Anthropic-compatible `/v1/messages`** — added at M7 to make the Claude Code snippet honest (system/text/images, tools + tool_use/tool_result, SSE event replay, first-pool fallback for `claude-*` names, disclosed).
- **Guided CLI** (`setup`/`serve`/`doctor`) with BYOK presets (Groq, Gemini, Cerebras, Mistral, NVIDIA NIM, OpenRouter, custom), 1-token key probes before anything is stored, live model discovery, `.env` awareness.
- **Benchmark report generator** with a committed stub dry-run example; **Quality dashboard view**; landing page; fresh docs; CI (Ubuntu+Windows, Node 22/24).

### Fixed along the way (latent bugs inherited from the original)
- **Test isolation**: router/revive/notify tests silently resolved providers from the machine's *live config* — now hermetic (stubbed `config.getProvider`).
- **Two pre-existing red tests** in `aistudio-think-sig` (failing on the live instance too): `remember()` no longer caches empty signature entries; the history-restore test now asserts the documented tool-result name injection.
- **UI serving**: the bundle now ships next to the app (`dist/` in the repo/package), not in the user home.
- CLI input on piped stdin (Node promise-readline drops sequential questions on non-TTY) — scripted installs work.

## 2. How to run it end-to-end

```bash
cd C:\Users\<you>\Projects\cupbearer

npm test                          # 238 unit tests, hermetic, ~15s, no keys
npm run smoke                     # stub upstreams + real gateway: failover, streaming, headers

npm --prefix ui install           # first time only
npm run build                     # dashboard → dist/  (already built in this checkout)

set CUPBEARER_HOME=%USERPROFILE%\.config\cupbearer2   # any fresh dir (optional)
node scripts\cli.js setup         # pick providers (or custom endpoint), paste keys,
                                  # 1-token probe, starter pool, gate mode
node scripts\cli.js serve         # gateway on http://127.0.0.1:4143
node scripts\cli.js doctor        # add --probe for live 1-token checks

# then connect:
#   Cursor:  base URL http://127.0.0.1:4143/v1, model "smart"
#   Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:4143  ANTHROPIC_AUTH_TOKEN=local
#   anything OpenAI: same /v1/chat/completions

node scripts\benchmark.js --pool smart --reps 5    # the report (markdown + JSON)
node scripts\benchmark.js --stub                    # dry run, no keys needed
```

A full walkthrough (wizard → doctor → gateway → live completion) was executed in a throwaway home directory and took seconds of interaction — comfortably inside the 5-minute bar.

## 3. What the benchmark run showed

The committed example (`docs/benchmark-example.md` + `.json`) is a **stub dry run**, clearly labeled as such: 12/12 task checks, 10 gated downgrade attempts evaluated — 6 held, 4 blocked & rerouted — with the routing table showing cheap legs serving small tasks and strong legs serving everything the gate escalated. The machinery (fixed workload, deterministic checks, honest failures, quality-evidence pull, cost accounting) is validated end-to-end.

**It is not launch content until it runs against real providers.** That needs your keys (by design, none exist in this repo). One command once configured:

```bash
node scripts\benchmark.js --pool smart --reps 5 --out docs\benchmark-real
```

## 4. Known gaps (honest list)

1. **Anthropic surface streams by replay, not relay** — `/v1/messages` with `stream:true` dispatches non-streaming and replays the completed result as SSE events. Correct and agent-friendly, but time-to-first-byte equals total latency. Real streaming translation is the top roadmap item for Claude Code power users.
2. **The profiler is heuristic** — no LLM-assisted classification yet. Task-type detection beyond tools/vision/size (e.g. "this is a reasoning problem") is roadmap.
3. **No multimodal passthrough endpoints** — the original's hardcoded `/v1/audio` and `/v1/vision` helpers were removed rather than generalized; a proper file-upload surface is real work (roadmap).
4. **Benchmark has no latency/quality comparison mode** (gate-off vs gate-on in one run) — today it reports one pool as configured plus the gateway's own gate evidence.
5. **No browser-based screenshots in the repo** — the dashboard was verified by build + live API checks; README/landing demo GIF placeholders await a real recorded session (yours to capture on your pools).
6. **UI tests are absent** — the React app is unchanged in structure from the audited original (which had none); the server suite covers everything behind it.
7. **`waf-headers` ships opt-in only** per your amendment: not in presets, absent from README/landing/CHANGELOG launch copy, documented only in `docs/quirks.md` with an explicit opt-in note.
8. **Git identity is a repo-local placeholder** (`cupbearer <cupbearer@users.noreply.github.com>`) — set your real identity before pushing: `git config user.name "…" && git config user.email "…"`.

## 5. Recommended next steps for launch

1. **Run the real benchmark** (command above) on your own pools; if the numbers hold, replace the README/landing sample table + record the demo GIF over the dashboard.
2. **Claim the name**: npm `cupbearer` (verify it's still free on publish day), GitHub org/repo (URLs are set to `cupbearer-gateway/cupbearer` in package.json and landing links — adjust if you pick another org), and the landing page via GitHub Pages (`landing/` is static, zero build).
3. **Set your git identity + push**, enable the CI workflow (runs green by design on Ubuntu + Windows, Node 22/24: tests, smoke, UI build, benchmark dry run).
4. **Publish**: `npm publish` (prepublishOnly builds the dashboard; `files` ships `server/`, `scripts/`, `ui/`, `docs/`).
5. **Launch posts**: the hook is the benchmark table + the Quality-view GIF ("watch the gateway refuse a cheap answer before the client sees it"). Keep the BYOK/ToS statement prominent — it preempts the first HN objection.
6. **Post-launch roadmap** (from PLAN.md §8): MCP exposure, hosted service, multi-tenant, billing, model training, resale — all deliberately out of scope for v1; plus client-preset exports and generalized multimodal passthrough.

## 6. Scorecard against the brief

| Brief bar | Status |
|---|---|
| Stranger: npm install → working multi-provider gateway in < 5 min | ✅ wizard + serve executed in a throwaway home; real keys are the only human step |
| Quality gate with stored, reportable evidence | ✅ shadow/gate modes, SQLite decisions, dashboard view, benchmark report |
| Tests that actually run (`npm test`) | ✅ 238/238 hermetic, Windows-first, no keys needed |
| Live smoke test actually executed | ✅ stub-upstream e2e: failover, streaming, headers, error semantics |
| Keep multi-provider / key pooling / failover / OpenAI surface / classification | ✅ ported with tests |
| Remove everything personal | ✅ seed script (keys!) never copied; adapters/endpoints/paths scrubbed; scans clean |
| $0 budget, minimal deps, Windows-first, BYOK, no telemetry | ✅ zero runtime deps (node:sqlite), loopback guard, MIT |
| Milestone protocol: status after each, tests before done, REVIEW at the end | ✅ this document |
