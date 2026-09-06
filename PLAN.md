# PLAN.md — Rebuild of "Conflux" into a shippable open-source product

**Status: APPROVED 2026-09-06.** Amendments: (1) name = **Cupbearer** (final); (2) waf-headers ships opt-in only — never in presets/default configs, unmentioned in README/landing/launch copy; (3) M7 DoD now includes copy-paste Claude Code + Cursor connect snippets in README and landing page.
Date: 2026-09-05 · Project folder: `the local project folder` (placeholder name; renamed once the product name is picked)

---

## 0. Executive summary

The existing codebase at `~/.config/conflux (private live deployment)` is **much better than a typical personal project** — the core gateway (router, relay, health, classifier, quirks system, 23 test files) is well-engineered, stdlib-only, and well-documented. Most of it ports cleanly. The personal layer (client adapters for opencode/ZCode, hardcoded Groq audio endpoint, seed script with **plaintext API keys and personal emails**, personal proxy topology in docs/config) is clearly separable and gets removed.

The biggest finding vs. the brief: **`classify.js` classifies upstream *failures*, not request difficulty.** There is no request profiler in the codebase today. The rebuild needs both: the error classifier stays as-is, and a new request profiler + tiered routing + quality gate is genuinely new build. Also, the existing `"quality"` keyStrategy is latency/success-rate key scoring, **not** output-quality verification — the differentiator is net-new, which is good news: it can be designed properly against the excellent deferred-commit failover architecture that already exists.

Plan: 7 milestones (M1 scaffold/port → M7 launch layer), one new runtime dependency (`better-sqlite3`), default port **4143** (4141 stays with the live instance), MIT, `npx <name>` guided setup, and a name change (10 candidates vetted against npm/GitHub/web below; recommendation: **Cupbearer**, runner-up **TrueGate**).

---

## 1. Ground rules & audit method

- The live instance at `~/.config/conflux (private live deployment)` was treated as **read-only**. Files were only read (directly, or via a read-only audit subagent). Nothing was opened, written, or executed against it. `secrets.json` was deliberately **not read** (its schema is known from `server/secrets.js`); `metrics/*.jsonl` and `logs/` were inspected for structure only.
- **Never copied into this project**: `secrets.json`, `config.json` (21 providers / 22 pools are the user's personal routing setup — the new repo ships an empty config + presets instead), `config.json.bak-pre-aistudio`, `health-state.json`, `metrics/`, `logs/`, `dist/` (regenerable build output), and above all `scripts/seed.js` + `seed.js.bak` (contain **plaintext API keys, a local proxy token, personal email addresses, and spend figures**).
- Working folder created: `the local project folder` — empty until M1 (after plan approval).

---

## 2. Code inventory — keep / refactor / remove

Ratings: **KEEP** = port as-is (mechanical rename only) · **REFACTOR** = port with real changes · **REMOVE** = does not ship in v1 · **NEW** = build from scratch.

### 2.1 `server/` — request path core

| File | LOC | What it does | Verdict | Notes |
|---|---|---|---|---|
| `index.js` | 197 | Bootstrap: one process serves `/v1/*`, `/api/*`, dashboard; loopback-only security boundary; graceful shutdown; uncaught handlers | KEEP | Rename branding, port default → 4143, env prefix |
| `paths.js` | 39 | Single source of disk locations; `CONFLUX_PORT`/`CONFLUX_HOST` env | REFACTOR | Drop `OPENCODE_DIR`, `ZCODE_DIR`, `ZCODE_CONFLUX_PROVIDER_ID` (hardcoded UUID); new default port; `<NAME>_HOME` override |
| `config.js` | 292 | Config store: providers/pools/settings, atomic writes, strict validation (17 settings, pool/provider id rules) | REFACTOR | Extend schema: leg `tier` + `capabilities`, pool `qualityGate`; bump config version; keep back-compat defaults |
| `secrets.js` | 94 | Key-value secret store, separate file, Windows ACL lockdown (icacls) / chmod 600, masked display, write-only through API | KEEP | This design is better than .env for a running gateway; .env import supported in the setup wizard |
| `http-util.js` | 44 | json/error/body helpers, 64 MB body limit | KEEP | |
| `events.js` | 84 | In-process event bus + SSE fan-out with backpressure guard | KEEP | |
| `classify.js` | 333 | **Error** classifier: 13 observed message rules + status fallbacks → `{reason, keyState, scope, retry}` verdicts | KEEP | Battle-tested (incl. Chinese reseller wording); generalize comments only. NOT a request profiler — see §3.3 |
| `health.js` | 321 | Key health state machine (healthy/cooling/degraded/exhausted/auth_failed/dead), exponential cooldown, sticky-state persistence with TTLs | KEEP | |
| `metrics.js` | 209 | In-memory rolling window + daily JSONL append, retention | REFACTOR | Same interface over SQLite (§3.7); JSONL retired |
| `notify.js` | 90 | Windows toast on failover (via `toast.ps1`), per-source cooldown + global gap, fire-and-forget | KEEP | Cross-platform guarded (no-op where powershell absent) |
| `revive.js` | 112 | Background re-probe of sticky keys so recovered keys re-enter rotation | KEEP | |
| `canary.js` | 117 | Optional background probe of healthy keys (off by default) | KEEP | |
| `upstream.js` | 233 | Outbound call: `callJson` / `openStream` / `listModels`; **never writes to the client** — that's what makes failover safe | KEEP | |
| `relay.js` | 324 | SSE relay with deferred commit (`onFirstByte`), stream translators, in-stream error withholding, usage observation | REFACTOR | Add an optional full-buffer capture mode so the quality gate can evaluate pre-commit (§3.5) |
| `router.js` | 788 | The heart: pool plan → leg walk → key walk, failover contract (pre-commit only), request time budgets, notification policy | REFACTOR | Add tier-aware leg ordering + quality-gate hooks; keep the failover contract and budget logic untouched |
| `openai-surface.js` | 449 | `GET /v1/models`, `POST /v1/chat/completions` (pool ids as models, `providerId/model` escape hatch), plus `/v1/audio/transcriptions` and `/v1/vision` | REFACTOR | Keep models + chat (real streaming works). **Remove** audio (hardcodes Groq + a hardcoded URL) and vision (reads local file paths, assumes a `"vision"` pool) — personal conveniences, roadmap §8 |

### 2.2 `server/` — dashboard API & client adapters

| File | LOC | What it does | Verdict | Notes |
|---|---|---|---|---|
| `api.js` | 577 | Dashboard REST: overview, pools, providers, keys (bulk add, test, reveal, clear), settings, revive/canary, rotation restart, SSE | REFACTOR | Remove `clients/sync` + `opencode` compat block; add quality-decisions and benchmark endpoints |
| `adapters/index.js` | 62 | Client adapter manager (opencode + zcode) | REMOVE | Personal clients. Roadmap: generic "client presets" export |
| `adapters/opencode.js` | 21 | opencode adapter | REMOVE | |
| `adapters/zcode.js` | 108 | ZCode adapter (hardcoded provider UUID) | REMOVE | |
| `opencode-config.js` | 280 | Surgical JSONC byte-range writer for `~/.config/opencode/opencode.jsonc` | REMOVE | Clever, but exists only for one personal client |

### 2.3 `server/quirks/` — provider normalization shims

| File | LOC | Quirk | Verdict |
|---|---|---|---|
| `index.js` | 108 | Registry + composition (5 hooks, single-translator rule) | KEEP |
| `aistudio-schema.js` | 250 | JSON-Schema sanitizer for strict upstream parsers | KEEP (neutral docs) |
| `aistudio-think-sig.js` | 251 | Thought-signature cache/reinject for Gemini 3.x tool calls | KEEP |
| `aistudio-multipart.js` | 100 | Multipart upload shim | KEEP |
| `deepseek-tools.js` | 576 | Unterminated `<think>`, sentinel tokens, duplicate tool calls, output caps | KEEP |
| `qwen-xml.js` | 555 | XML-in-plaintext tool calls → structured deltas | KEEP |
| `think-tags.js` | 170 | `<think>` tags split across chunks → `reasoning_content` | KEEP |
| `nvidia-nim.js` | 125 | `tools` on vision requests → 400; omni thinking budget | KEEP |
| `openrouter.js` | 118 | Reasoning-token budget; keepalive SSE lines | KEEP |
| `waf-headers.js` | 49 | Browser-like headers for WAF-fronted gateways | KEEP |
| `sse-null.js` | 32 | `data: null` keepalive drops | KEEP |
| 8 `.test.js` files | ~1,800 total | Verbatim-payload fixtures | KEEP |

This subsystem is a genuine differentiator ("normalizes broken OpenAI-compatible upstreams without polluting the router") and ships with its docs. The `aistudio-*` quirks are passive request/response shims — fine to ship; the personal AIStudio2API *service* they talk to is not shipped and not documented as a recipe.

### 2.4 Tests (23 files, `node --test`, colocated `*.test.js`)

| Group | Files | Verdict |
|---|---|---|
| Router behavior (budget, failover, maxkeys, fastest-first, notify) | 5 | KEEP — adapt to tier/gate hooks |
| Relay, classify, health persistence, metrics hydrate, config settings, notify, revive, canary, openai-surface status | 13 | KEEP |
| adapters (2), opencode-config (1) | 3 | REMOVE with their modules |
| New: profiler, tier ordering, quality gate (pass/fail/upgrade, shadow), store, presets, report | — | NEW (M2–M4) |

Note: tests use `node --test server/**/*.test.js`; Node ≥ 22 handles the glob natively (host runs v24.19). `engines` will pin `>=22`.

### 2.5 `scripts/`

| File | LOC | Verdict | Notes |
|---|---|---|---|
| `seed.js` | 619 | **REMOVE — never copy** | Plaintext keys, personal emails/spend, personal proxy topology, stale vs live config. Replaced by presets + guided setup (§3.9) |
| `seed.js.bak` | ~515 | **REMOVE — never copy** | Same content, older |
| `doc-pointer.js` | 77 | KEEP | Stamps `// DOC:` pointers mapping modules → docs sections; generic convention worth keeping |
| `toast.ps1` | 152 | KEEP | Self-contained WinRT toast, no deps |
| `make-icon.ps1` | 212 | KEEP | Regenerates brand ICO/PNG (will be re-run for the new name/icon) |
| `benchmark.js`, `smoke.js`, `cli.js` (setup wizard) | — | NEW | M4 / M1 / M5 |

### 2.6 `ui/` — React 19 + Vite 7 + Tailwind 4 dashboard

| File | LOC | Verdict | Notes |
|---|---|---|---|
| `src/App.jsx` | 394 | REFACTOR | Remove hardcoded `zcode`/`opencode` client labels & banners |
| `src/api.js` | 112 | REFACTOR | Drop `syncOpencode` alias; add quality/benchmark endpoints |
| `src/components/PoolBuilder.jsx` | 484 | REFACTOR | Remove "what opencode calls" copy |
| `src/components/Operations.jsx` | 312 | REFACTOR | Remove client-config rewrite section; add quality settings |
| `src/components/{PoolsGrid,PoolDetail,Providers,KeyManager}.jsx` | 339/426/544/285 | KEEP | Excellent CRUD + monitoring UI |
| `src/components/{ui,icons}.jsx`, `src/format.js`, `src/index.css`, `src/main.jsx`, `index.html`, `vite.config.js`, `package.json` | — | KEEP | Hand-rolled design system, no chart/router deps, WCAG-conscious |
| NEW Quality/Benchmark views | — | NEW | Route decisions with scores, quality-hold rate, benchmark results (M6) |
| `package-lock.json`, `dist/` | — | REGENERATE | Never copied |

### 2.7 `docs/` and root files

| File | LOC | Verdict | Notes |
|---|---|---|---|
| `docs/architecture.md` | 504 | REFACTOR | Module map + request lifecycle are superb; excise "Upstream Provider Topology" (personal 3-tier proxy stack) |
| `docs/quirks.md` | 537 | REFACTOR | Crown jewel; generalize reseller names |
| `docs/api.md` | 288 | REFACTOR | Full reference; drop audio/vision sections, rename headers |
| `docs/operations.md` | 577 | REFACTOR | Settings reference + troubleshooting playbook; drop "Companion Local Proxies" (2 sections) |
| `docs/extending.md` | 242 | REFACTOR | Quirk-authoring + invariants guide survives |
| `docs/README.md` | 212 | REFACTOR → root `README.md` | Rewritten for launch (§5 of brief) |
| `start-conflux.bat` / `conflux-start.vbs` | 22 | REMOVE | Hardcoded `the user profile` paths; autostart documented in docs instead |
| `package.json` | 12 | REWRITE | name (TBD), version 0.1.0, `bin`, `engines: >=22`, `files`, MIT, scripts (start/setup/serve/test/benchmark/smoke/build) |
| `config.json`, `secrets.json`, `health-state.json`, `metrics/`, `logs/`, `dist/`, `config.json.bak-pre-aistudio` | — | NEVER COPIED | New instances generate their own |

---

## 3. Target architecture

### 3.1 Module layout (new repo)

```
<name>/
├─ package.json            bin entry, engines >=22, MIT, files allowlist
├─ LICENSE (MIT) · CHANGELOG.md · README.md · PLAN.md
├─ .gitignore              secrets, config, *.db, dist, logs, metrics — from commit #1
├─ .env.example
├─ server/
│  ├─ index.js  paths.js  config.js  secrets.js
│  ├─ http-util.js  events.js  classify.js  health.js  metrics.js
│  ├─ notify.js  revive.js  canary.js  upstream.js  relay.js  router.js
│  ├─ openai-surface.js  api.js  presets.js  store.js
│  ├─ profile.js           NEW — request profiler (size, tools, vision, task type → tier)
│  ├─ quality/             NEW — evaluators.js, judge.js, gate.js
│  ├─ quirks/              10 shims + registry + tests
│  └─ *.test.js            node --test, colocated
├─ scripts/  cli.js (setup/serve/doctor) · benchmark.js · smoke.js · doc-pointer.js
├─ ui/       React app → dist/ (served by the gateway)
├─ landing/  static GitHub Pages site
└─ docs/     architecture · api · operations · extending · quirks
```

### 3.2 Request lifecycle (the brief's flow: request → classify → route → adapter → verify → respond)

```
POST /v1/chat/completions
  │  openai-surface: parse body, resolve model → pool (or providerId/model escape hatch)
  ▼
profile.js        NEW: request profiler → { tokensIn(est), hasTools, hasImages,
  │                       taskType: chat|code|json|tools|vision, requiredTier }
  ▼
router.dispatch   plan = pool.legs filtered by capability sufficiency,
  │               ordered by tier fit (see §3.4), then existing key strategies
  ▼
for each (leg, key) attempt:
  ├─ upstream.callJson / openStream   (quirks applied; never writes to client)
  ├─ fail pre-commit → classify.js verdict → retry key / leg / stop   (unchanged)
  └─ success:
       ├─ leg tier < requiredTier  and gate.mode = "gate"
       │     → relay buffers full response pre-commit (deferred-commit makes this free)
       │     → quality.gate.evaluators (+ optional judge) → score ≥ threshold?
       │          pass  → commit & respond (score logged)
       │          fail  → do NOT commit; try next stronger leg; decision logged
       ├─ leg tier OK → commit & stream through as today (zero added latency)
       └─ gate.mode = "shadow" → respond normally; evaluate post-hoc; log only
  ▼
store.js (SQLite): request row, attempt rows, gate/route decisions, scores
events → dashboard SSE: live decisions with quality scores
```

The key architectural gift from the old code: **commit is already deferred to the first flushed byte** (`relay.onFirstByte`). A gate that must decide "serve this or fall back" slots into the same mechanism translators already use — no change to the failover contract.

### 3.3 The two classifiers (naming to avoid confusion)

- `classify.js` — **failure** classifier (upstream errors → key/leg/request scope). Ported as-is.
- `profile.js` — **request** profiler (new). Heuristic, $0, ~0 ms: token estimate (chars/4 + per-message overhead), tool presence, image parts, JSON/strict-format hints, context window needed → maps to a **required tier** (1 flagship / 2 standard / 3 light) and capability list. No LLM call at this stage (an optional LLM-assisted profiling mode is a roadmap item; heuristic default keeps the "cheap" promise).

### 3.4 Tiered routing model

- Each pool leg may declare `tier` (1 = strongest … 3 = light) and `capabilities: ["tools","vision","long-context","json"]`. Legs without declarations default to the pool's primary tier — old configs route exactly as before.
- Leg ordering: (1) filter by capability sufficiency; (2) among sufficient legs, prefer the **highest tier number (cheapest) that meets the required tier**; (3) within a tier, existing `keyStrategy` (round-robin / sticky-until-error / fastest-first / quality) and health ordering apply.
- "Downgrade" = serving from a leg whose tier number is worse than the required tier. That is the only path the quality gate blocks.

### 3.5 Quality gate (the differentiator)

- **Modes** (per pool, default `off`, recommended default for new setups: `shadow`):
  - `off` — classic availability-only routing.
  - `shadow` — respond immediately; evaluate post-hoc; store scores. Zero latency cost; builds the evidence base.
  - `gate` — on downgrades only: buffer pre-commit, evaluate, commit or fall back to a stronger leg. First-choice legs never wait on the gate.
- **Evaluators** (heuristic, $0): JSON-validity (when JSON requested), refusal/empty detection, length sanity, repetition/n-gram loops, language match, tool-call shape validity. Each returns 0–1 with a reason; combined score configurable per tier (`threshold` per pool, e.g. 0.8).
- **LLM-as-judge** (optional): any configured provider/model can judge (pairwise vs a reference answer from a stronger leg, or standalone rubric). Judge calls run on **the user's own configured keys** and default to *off*; heuristics are the default judge so the $0 story stays honest. Judge leg should be a free-tier model by convention.
- **Config** (per pool): `qualityGate: { mode, threshold, evaluators: [...], judge: {providerId, model} | null, maxDowngrades: 2 }`.
- **Evidence**: every decision (route choice, downgrade attempt, gate pass/fail, score, evaluator breakdown, judge verdict) is a row in SQLite, queryable via the dashboard API — "the evidence is stored and reportable" is a hard requirement, not a nice-to-have.

### 3.6 Config model v2

- Same `config.json` + `secrets.json` split (diffable config / locked secrets — keep it). New `version: 2`; `config.js` migrates v1 configs (all new fields optional with today's behavior as default).
- New settings join the existing validated 17: `defaultQualityMode`, `gateTimeoutMs` (buffer cap), `storeRetainDays`. All validated with the same strictness.
- Env: `<NAME>_PORT` (default **4143**), `<NAME>_HOST` (127.0.0.1), `<NAME>_HOME`, `<NAME>_ALLOW_LAN` (same guardrail as today: non-loopback requires explicit opt-in because keys live unauthenticated behind the bind).

### 3.7 Storage model (SQLite via `better-sqlite3`)

```sql
requests(id, ts, pool_id, model_requested, profile_json, required_tier,
         committed_provider, committed_key, committed_model,
         ok, status, latency_ms, attempts, tokens_in, tokens_out, streamed)
attempts(id, request_id, ts, provider_id, key_id, model,
         ok, status, reason, message, latency_ms)
decisions(id, request_id, ts, kind,            -- route | gate | downgrade | upgrade
         from_provider, from_model, to_provider, to_model,
         gate_mode, evaluator, score, threshold, passed, detail_json)
```

- `store.js` exposes the same surface `metrics.js` has today (`record`, `overall`, `poolSummary`, `feed`, `series`) so the dashboard and tests keep working; JSONL daily files are retired (retention setting applies to the DB).
- WAL mode, prepared statements, all writes off the request hot path (batched flush like today's timer).

### 3.8 Rebranding mechanics

Mechanical, applied at M1 once the name is picked: env prefix, `x-conflux-*` response headers → `x-<name>-*`, error `type: "conflux_error"` → `<name>_error`, `[conflux]` log prefix, SSE ids, config paths, default port, UI labels/brand, icon (`make-icon.ps1` re-run). A repo-wide grep for `conflux` must come up empty (CHANGELOG provenance note excepted).

### 3.9 One-command experience

- `npx <name>` (or `<name>` after global install) with no config → guided setup: pick providers from built-in presets (Groq, Gemini, Cerebras, Mistral, NVIDIA NIM, OpenRouter, OpenAI-compatible custom…), paste keys (or read from env / `.env`), get a recommended starter pool, write `config.json` + `secrets.json`, start the gateway, print the dashboard URL.
- `presets.js`: per-provider `baseURL`, suggested free models, known quirks (e.g. nvidia → `nvidia-nim` quirk), docs link. Community-extensible.
- `doctor` subcommand: config parse, key presence (masked), one-token live probe per provider, dashboard reachability.
- Existing installs keep working via `<name> serve`.

### 3.10 Dashboard & landing

- Dashboard (M6): port the React app; add a **Quality view** (live decisions feed with scores, gate outcomes, downgrade/upgrade counters, per-pool quality-hold rate) and a **Benchmark** view (past report runs). Client-sync UI removed.
- Landing (M7): static `landing/index.html` for GitHub Pages — hero one-liner, 30-second quickstart, benchmark table placeholder, "vs DIY LiteLLM config" comparison, demo GIF placeholder, MIT badge, zero build tooling.

---

## 4. Milestone plan

Protocol per brief: after each milestone → short status (done / next / deviations); `npm test` must pass before any milestone is declared done; final state = green tests + an executed smoke test; `REVIEW.md` at the end, then stop.

| # | Milestone | Definition of done |
|---|---|---|
| **M1** | **Scaffold & core port** | Repo skeleton (package.json w/ bin+engines, MIT LICENSE, .gitignore, .env.example, git init). Port the keep/refactor list from §2 with all personal code removed and rebranding applied. Server boots on 4143, `/v1/models` + `/healthz` respond. All ported tests green under `npm test`. Smoke test (`scripts/smoke.js`) passes: it boots a **stub OpenAI-compatible upstream on 127.0.0.1:0** plus the gateway on an ephemeral port and runs a real completion through router+relay+quirks — works with zero API keys, so CI can run it. No `conflux`/personal strings in tree; first commit contains no secrets (verified by grep). |
| **M2** | **Profiler & tiered routing** | `profile.js` + schema/validation for leg `tier`/`capabilities` + router ordering per §3.4. Unit tests: profiler buckets, capability filter, tier ordering, back-compat for undeclared legs. |
| **M3** | **Quality gate + SQLite** | `store.js` (better-sqlite3), `quality/evaluators.js`, `quality/judge.js`, `quality/gate.js` wired into router (buffered pre-commit path in relay). Gate pass → commit; fail → next stronger leg; shadow mode logs post-hoc. Decisions persisted and exposed via `/api/quality/*`. Tests cover gate pass/fail/upgrade-retry, shadow, each heuristic evaluator, store round-trip. |
| **M4** | **Benchmark report generator** | `scripts/benchmark.js`: fixture workload suites (JSON mode, tool calls, summarization, code, refusal-handling) run against a real configured pool; outputs `benchmark-report.md` + `.json` with honest numbers (N requests, % downgraded, quality-hold %, tokens, est. $ using a user-declared price table, latency p50/p95, failures included). A real generated report committed as `docs/benchmark-example.md` + methodology note. |
| **M5** | **One-command UX** | `presets.js` + `scripts/cli.js`: `setup` wizard (guided provider/key/pool flow), `serve`, `doctor`; `.env` import. DoD: a from-scratch walkthrough executed in a throwaway home dir using stub/real keys per availability, ≤ 5 minutes end-to-end, no manual file editing. |
| **M6** | **Dashboard** | UI ported (client-sync removed), Quality + Benchmark views added, `npm run build` produces `dist/`, verified against a running instance with stub providers; screenshots captured for README/landing. |
| **M7** | **Launch layer** | `landing/`, README rewrite, 5 docs generalized, CHANGELOG, GitHub Actions CI (Windows + Linux matrix, test + smoke, $0), final full `npm test` + executed smoke, **REVIEW.md** (changes vs original, exact run commands, benchmark results, known gaps, launch next steps). Stop for human review. |

---

## 5. Naming candidates

Method: npm registry check (404 = unregistered), GitHub user/org + repo-search API, web search for companies/products. Checked 2026-09-05.

| Candidate | npm | GitHub space | Web | Verdict |
|---|---|---|---|---|
| **Cupbearer** ⭐ | **free** | clean — one unrelated 22★ ML-research lib | bra-fit app, a Steam game, biblical references — no dev-tools collision | **Recommendation.** The historical cupbearer tasted the king's wine before the king drank — exactly this product. Great HN story, brandable |
| **TrueGate** ⭐ | **free** | 10 tiny repos (one 0★ conceptually identical, no traction) | clean | Runner-up: self-explanatory, safe |
| **Belayer** ⭐ | **free** | 18 repos, largest 6★; one tiny Go agent-orchestrator | clean | Runner-up: the person who catches your fall; short, active |
| Weighstation | free | 3 trivial repos | Paradigm's **WeighStation®** is a registered mark in weighing/routing software | Trademark-adjacent, clunky |
| Verigate | free | 54 repos incl. "Verifier-gated distillation" (conceptually adjacent) | KYC firm | Semi-crowded in exactly our niche |
| Soundcheck | free | 321 repos incl. a 20★ "security reviews for AI agents" | music apps | Crowded |
| Gatewright | free | 6 repos | **gatewright.com — SF R&D/IT firm** | SEO collision, drop |
| Understudy | taken | — | — | Great metaphor, no npm room |
| Touchstone | taken | — | — | |
| Gatekeep / Gatehouse / Drawbridge / Vouchsafe / Portcullis / Greenlight / Assay / Assayer / Taster / Spotter / ProofGate | taken | — | ProofGate also exists as an "AI agent firewall" | |

**Recommendation: Cupbearer** (unique namespace + perfect metaphor), with **TrueGate** as the "explain itself in one word" alternative. The human picks; M1 rebranding depends on it.

---

## 6. Risk list

**ToS / provider relations (positioning-critical)**
- BYOK, always: the tool only uses keys the user configures locally; no bundled, shared, pooled, or resold keys; no hosted multi-user service. Document this on the landing page and README in plain language ("bring your own keys, respect your provider's terms").
- Free-tier automation is the user's own account usage — same as any SDK. We never bypass official APIs; the personal AIStudio2API private-RPC *service* is not shipped or documented as a recipe (its passive quirk shims ship, harmlessly).
- No telemetry, no phone-home, benchmark/eval runs stay on the user's machine.

**Technical**
- Gate-mode latency: buffering a full response before commit adds time-to-first-byte on downgraded requests. Mitigation: `shadow` is the default; `gate` applies to downgrades only; first-choice legs never buffer; `gateTimeoutMs` caps buffering.
- Judge cost/quota burn: judge defaults to off; heuristics are the default judge; docs recommend pointing the judge at a free-tier leg.
- `better-sqlite3` native module on Windows: ships prebuilt binaries for LTS Node; `engines >=22` + CI on Windows catches breakage; worst case the store interface has a JSONL fallback path (documented, not built unless needed).
- Single-process scale ceiling: this is a personal/team gateway, not a service — stated honestly in docs.
- Streaming edge: mid-stream quality failure post-commit is reportable, never retryable (existing contract, unchanged).

**Launch**
- Name: "Conflux" is a major blockchain — SEO death; renaming is mandatory (hence §5). Register the npm name and GitHub org the moment the human picks.
- Benchmark credibility: publish methodology + raw JSON alongside the summary; report failures; disclose judge model and threshold; no cherry-picking. A skeptical HN should find the receipts.
- "LLM-judge judging its own vendors" skepticism: answered by heuristics-first default and the evidence store (every score queryable).
- Scope creep: §8 is the fence.

---

## 7. Dependency policy

Stack stays Node.js core-only. Additions require a one-line justification here:

| Dependency | Milestone | Justification |
|---|---|---|
| `better-sqlite3` | M3 | Synchronous embedded storage for request logs + gate/eval evidence; prebuilt Windows binaries; the brief mandates SQLite. (No ORM, no query builder.) |
| UI: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, 2 fontsource packages | M6 (port) | Already the dashboard's stack; all used; no additions |
| CLI wizard | M5 | Built with `node:readline/promises` — no inquirer dependency needed |

---

## 8. Out of scope for v1 (roadmap)

From the brief: MCP server exposure · hosted/cloud service · multi-tenant · billing/payments · model training · proxy reselling.
Added during audit: client-config adapters (opencode/ZCode JSONC sync — the generic "client presets" idea can return later) · `/v1/audio/transcriptions` + `/v1/vision` helper endpoints (generalized multimodal passthrough is real work) · LLM-assisted request profiling · JSONL log export · Windows service/autostart installer · UI unit tests.

---

## 9. Decisions made by default (override anything in review)

1. Default port **4143** (4141 = live instance, 4142 = old vite dev port); configurable via env.
2. `engines.node >= 22` (host runs v24.19; native glob support in `node --test`).
3. SQLite replaces the JSONL call log (interface-compatible; retention setting carries over).
4. `secrets.json` stays the canonical key store (better than `.env` for a running gateway: ACL lockdown, masked display, write-only API); `.env` is an *import* path in the wizard.
5. The `aistudio-*` quirks ship (passive shims); the personal services they were built for do not.
6. Working folder `the local project folder` is a placeholder until the name is picked, then renamed.
7. `notify` (Windows toasts) ships default-on with the existing cooldowns; graceful no-op elsewhere.

## 10. What I need from the human

1. **Pick the name** (§5) — M1 rebranding depends on it.
2. Confirm or veto the v1 removals: client adapters + JSONC writer, audio/vision helper endpoints, `.bat`/`.vbs` autostart, seed script (replaced by presets + wizard).
3. Confirm default port 4143 and SQLite-over-JSONL.
4. Green-light M1.
