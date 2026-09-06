# Cupbearer benchmark — pool `demo`

*Run: 2026-09-06 00:26 · gateway: http://127.0.0.1:42374 · **dry run against bundled stub providers (no real LLMs)***

| Metric | Value |
|---|---|
| Workload | 6 tasks × 2 reps = **12 requests** |
| Task pass rate | **100.0%** (12/12) |
| Latency (ok responses) | p50 29 ms · p95 169 ms |
| Tokens | 1440 in / 480 out |
| Cost | **$0.00 spent** (free-tier keys; no price table supplied, so nothing was estimated) |
| Quality gate (gateway evidence, last 24h) | 10 downgrade attempt(s) evaluated — 6 held, **4 blocked & rerouted**; served responses never fell below the bar |

## Per task

| Task | Kind | Pass | Notes |
|---|---|---|---|
| json-object | structured output | 2/2 | — |
| instruction-follow | exact format | 2/2 | — |
| summarize | condensation | 2/2 | — |
| code-gen | code | 2/2 | — |
| extraction | structured output | 2/2 | — |
| agentic-plan | tool calls + planning | 2/2 | — |

## Routing (who actually served)

| Leg (provider/model) | Served | Task-passed |
|---|---|---|
| stub-strong/stub-strong-v1 | 4 | 4 |
| stub-cheap/stub-cheap-v1 | 8 | 8 |

## Methodology

- Fixed workload, fixed prompts; every request and every failure is reported, nothing is retried or cherry-picked.
- Requests went through the gateway's normal OpenAI-compatible surface with tiered routing and the quality gate exactly as configured — the benchmark does not special-case anything.
- Task checks are deterministic (JSON validity, exact format, extract correctness, code shape, length bounds).
- **This run used bundled stub providers, not real LLMs** — it demonstrates the report machinery end to end. Regenerate against a configured pool for real numbers.
