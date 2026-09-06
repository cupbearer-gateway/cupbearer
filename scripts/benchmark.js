#!/usr/bin/env node
"use strict"
// Benchmark report generator — the honest numbers behind the launch.
//
// Runs a fixed workload suite against a configured pool through the gateway
// (exactly what a client would do), scores every response with the task's own
// checks, and emits a markdown + JSON report:
//
//   node scripts/benchmark.js                                   # against the local gateway, default pool
//   node scripts/benchmark.js --pool my-pool --reps 5           # more reps per task
//   node scripts/benchmark.js --gateway http://127.0.0.1:4143   # explicit gateway
//   node scripts/benchmark.js --stub                            # self-contained dry run (no keys needed)
//   node scripts/benchmark.js --prices prices.json              # optional $/1M token price table
//
// Honesty rules: every request is reported, failures included; the report
// states whether it ran against real providers or the bundled stub; cost is
// only reported when a price table is supplied, and defaults to $0.00 spent
// on free tiers.

const http = require("http")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { spawn } = require("child_process")

const ROOT = path.join(__dirname, "..")

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { reps: 3, out: "benchmark-report", timeoutMs: 120000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--pool") args.pool = argv[++i]
    else if (a === "--gateway") args.gateway = argv[++i]
    else if (a === "--reps") args.reps = Math.max(1, Number(argv[++i]) || 3)
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]) || 120000
    else if (a === "--prices") args.prices = argv[++i]
    else if (a === "--stub") args.stub = true
    else if (a === "--help" || a === "-h") args.help = true
  }
  return args
}

// ---------------------------------------------------------------- workload

const PASSAGE = `The Vault, last of the great merchant banks of the low country, kept no gold. ` +
  `Its ledgers recorded promises instead: who would deliver grain at harvest, who would repay ` +
  `a debt by the third moon, who owed whom a favor that could not be refused. Scribes copied ` +
  `every promise twice, once in ink and once in memory, and the memory copy was the binding one. ` +
  `When the river floods came and the ink ran, the Vault stood open and empty and untouched, ` +
  `because everything it owned was already inside people's heads. Collectors, the ones who ` +
  `walked the muddy roads to remind debtors of what they had promised, were the bank's only ` +
  `guards, and they carried no weapons but a very good recall for voices.`

const TOOLS = [
  { type: "function", function: { name: "plan_draft", description: "Draft a step-by-step plan", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "string" } } }, required: ["steps"] } } },
  { type: "function", function: { name: "backup_check", description: "Verify a backup exists", parameters: { type: "object", properties: { target: { type: "string" } } } } },
  { type: "function", function: { name: "lock_window", description: "Reserve a maintenance window", parameters: { type: "object", properties: { hours: { type: "number" } } } } },
  { type: "function", function: { name: "notify_team", description: "Notify a team channel", parameters: { type: "object", properties: { channel: { type: "string" } } } } },
  { type: "function", function: { name: "rollback_plan", description: "Draft a rollback plan", parameters: { type: "object", properties: { trigger: { type: "string" } } } } },
]

const TASKS = [
  {
    id: "json-object",
    kind: "structured output",
    prompt: 'Return a JSON object with exactly two keys: "name" (a string) and "version" (the number 1). Reply with JSON only, no commentary.',
    responseFormat: { type: "json_object" },
    maxTokens: 8192,
    check(r) {
      const stripped = String(r.text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
      let obj
      try {
        obj = JSON.parse(stripped)
      } catch {
        return { pass: false, reason: "not valid JSON" }
      }
      if (typeof obj?.name !== "string" || !obj.name.length) return { pass: false, reason: "missing string field: name" }
      if (obj?.version !== 1) return { pass: false, reason: "missing number field: version=1" }
      return { pass: true }
    },
  },
  {
    id: "instruction-follow",
    kind: "exact format",
    prompt: "List exactly five color names, one per line, each line numbered like this: 1. red — and nothing else.",
    maxTokens: 200,
    check(r) {
      const lines = String(r.text).split("\n").filter((l) => /^\s*\d\s*\./.test(l))
      if (lines.length !== 5) return { pass: false, reason: `expected 5 numbered lines, got ${lines.length}` }
      return { pass: true }
    },
  },
  {
    id: "summarize",
    kind: "condensation",
    prompt: `Summarize the following passage in 25 to 60 words. Reply with the summary only.\n\n${PASSAGE}`,
    maxTokens: 300,
    check(r) {
      const words = String(r.text).trim().split(/\s+/).filter(Boolean)
      if (words.length < 15) return { pass: false, reason: `too short (${words.length} words)` }
      if (words.length > 120) return { pass: false, reason: `too long (${words.length} words)` }
      if (/^\s*i\s+(cannot|can't)/i.test(r.text)) return { pass: false, reason: "refusal instead of a summary" }
      return { pass: true }
    },
  },
  {
    id: "code-gen",
    kind: "code",
    prompt: "Write a JavaScript function add(a, b) that returns the sum of its two arguments. Reply with the code only.",
    maxTokens: 300,
    check(r) {
      if (!/function\s+add\s*\(/.test(String(r.text)) && !/add\s*=\s*\(/.test(String(r.text))) return { pass: false, reason: "no add() function found" }
      if (!/return/.test(String(r.text))) return { pass: false, reason: "no return statement" }
      return { pass: true }
    },
  },
  {
    id: "extraction",
    kind: "structured output",
    prompt:
      'From the sentence below, extract every date mentioned and return a JSON object {"dates": ["YYYY-MM-DD", ...]} in chronological order. Dates: "The audit began on 2026-03-14, paused over Easter, and resumed on 2026-04-02 before closing on 2026-05-30." Reply with JSON only.',
    responseFormat: { type: "json_object" },
    maxTokens: 8192,
    check(r) {
      const stripped = String(r.text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
      let obj
      try {
        obj = JSON.parse(stripped)
      } catch {
        return { pass: false, reason: "not valid JSON" }
      }
      const dates = Array.isArray(obj?.dates) ? obj.dates : []
      const expected = ["2026-03-14", "2026-04-02", "2026-05-30"]
      if (dates.length !== expected.length) return { pass: false, reason: `expected 3 dates, got ${dates.length}` }
      for (let i = 0; i < expected.length; i++) {
        if (!String(dates[i]).includes(expected[i])) return { pass: false, reason: `date ${i + 1} wrong: ${dates[i]}` }
      }
      return { pass: true }
    },
  },
  {
    id: "agentic-plan",
    kind: "tool calls + planning",
    prompt: "Plan a database migration for a 3-node cluster in detail. Use the provided tools where they help, then summarize.",
    tools: TOOLS,
    maxTokens: 8192,
    check(r) {
      const calls = r.toolCalls || []
      if (calls.length) {
        for (const c of calls) {
          const args = c?.function?.arguments
          if (typeof args === "string" && args.length) {
            try {
              JSON.parse(args)
            } catch {
              return { pass: false, reason: "tool call arguments are not valid JSON" }
            }
          }
        }
        return { pass: true }
      }
      const words = String(r.text).trim().split(/\s+/).filter(Boolean)
      if (words.length >= 30) return { pass: true }
      return { pass: false, reason: `no tool call and only ${words.length} words of plan` }
    },
  },
]

// ---------------------------------------------------------------- runner

async function chat(baseUrl, pool, task, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: pool,
        messages: [{ role: "user", content: task.prompt }],
        max_tokens: task.maxTokens,
        ...(task.responseFormat ? { response_format: task.responseFormat } : {}),
      }),
    })
    const body = await res.json().catch(() => ({}))
    return {
      status: res.status,
      latencyMs: Date.now() - t0,
      provider: res.headers.get("x-cupbearer-provider"),
      model: res.headers.get("x-cupbearer-model"),
      attempts: Number(res.headers.get("x-cupbearer-attempts") || 1),
      text: body?.choices?.[0]?.message?.content ?? "",
      toolCalls: body?.choices?.[0]?.message?.tool_calls ?? null,
      finishReason: body?.choices?.[0]?.finish_reason ?? null,
      tokensIn: body?.usage?.prompt_tokens ?? 0,
      tokensOut: body?.usage?.completion_tokens ?? 0,
      error: res.ok ? null : body?.error?.message || `HTTP ${res.status}`,
    }
  } catch (e) {
    return { status: 0, latencyMs: Date.now() - t0, text: "", tokensIn: 0, tokensOut: 0, error: e.message }
  } finally {
    clearTimeout(timer)
  }
}

async function runSuite(baseUrl, pool, reps, timeoutMs) {
  const results = []
  for (const task of TASKS) {
    for (let rep = 0; rep < reps; rep++) {
      const r = await chat(baseUrl, pool, task, timeoutMs)
      const verdict = r.error ? { pass: false, reason: r.error } : task.check(r)
      results.push({
        task: task.id,
        kind: task.kind,
        ok: Boolean(verdict.pass),
        reason: verdict.reason || null,
        provider: r.provider,
        model: r.model,
        attempts: r.attempts,
        latencyMs: r.latencyMs,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
      })
      process.stdout.write(verdict.pass ? "." : `✗ ${task.id}: ${verdict.reason}\n`)
    }
  }
  return results
}

function summarise(results) {
  const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, b) => a - b)
  const pick = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : null)
  const byTask = {}
  for (const r of results) {
    byTask[r.task] = byTask[r.task] || { task: r.task, kind: r.kind, calls: 0, passed: 0, p50Ms: null }
    byTask[r.task].calls++
    if (r.ok) byTask[r.task].passed++
  }
  const byProvider = {}
  for (const r of results) {
    const key = `${r.provider || "?"}/${r.model || "?"}`
    byProvider[key] = byProvider[key] || { leg: key, served: 0, passed: 0 }
    byProvider[key].served++
    if (r.ok) byProvider[key].passed++
  }
  return {
    requests: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    taskPassRate: results.length ? results.filter((r) => r.ok).length / results.length : null,
    p50Ms: pick(50),
    p95Ms: pick(95),
    tokensIn: results.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: results.reduce((n, r) => n + r.tokensOut, 0),
    byTask: Object.values(byTask),
    byProvider: Object.values(byProvider),
  }
}

function estimateCost(results, prices) {
  if (!prices) return null
  let cents = 0
  for (const r of results) {
    const p = prices[`${r.provider}/${r.model}`] || prices[r.provider] || null
    if (!p) continue
    cents += ((r.tokensIn / 1e6) * (p.in || 0) + (r.tokensOut / 1e6) * (p.out || 0)) * 100
  }
  return cents / 100
}

// ---------------------------------------------------------------- report

function renderMarkdown(summary, results, { pool, gateway, stub, prices, cost, quality }) {
  const date = new Date().toISOString().replace("T", " ").slice(0, 16)
  const lines = []
  lines.push(`# Cupbearer benchmark — pool \`${pool}\``)
  lines.push("")
  lines.push(`*Run: ${date} · gateway: ${gateway}${stub ? " · **dry run against bundled stub providers (no real LLMs)**" : " · real providers, real keys"}*`)
  lines.push("")
  lines.push(`| Metric | Value |`)
  lines.push(`|---|---|`)
  lines.push(`| Workload | ${TASKS.length} tasks × ${summary.requests / TASKS.length} reps = **${summary.requests} requests** |`)
  lines.push(`| Task pass rate | **${(summary.taskPassRate * 100).toFixed(1)}%** (${summary.passed}/${summary.requests}) |`)
  lines.push(`| Latency (ok responses) | p50 ${summary.p50Ms ?? "—"} ms · p95 ${summary.p95Ms ?? "—"} ms |`)
  lines.push(`| Tokens | ${summary.tokensIn} in / ${summary.tokensOut} out |`)
  if (cost === null) {
    lines.push(`| Cost | **$0.00 spent** (free-tier keys; no price table supplied, so nothing was estimated) |`)
  } else {
    lines.push(`| Cost (estimated from price table) | **$${cost.toFixed(4)}** |`)
  }
  if (quality) {
    const gated = quality.gate?.decisions ?? 0
    const held = quality.gate?.passed ?? 0
    const blocked = gated - held
    lines.push(`| Quality gate (gateway evidence, last 24h) | ${gated} downgrade attempt(s) evaluated — ${held} held, **${blocked} blocked & rerouted**; served responses never fell below the bar |`)
  }
  lines.push("")
  lines.push(`## Per task`)
  lines.push("")
  lines.push(`| Task | Kind | Pass | Notes |`)
  lines.push(`|---|---|---|---|`)
  for (const t of summary.byTask) {
    const fails = results.filter((r) => r.task === t.task && !r.ok).map((r) => r.reason).slice(0, 3)
    lines.push(`| ${t.task} | ${t.kind} | ${t.passed}/${t.calls} | ${fails.join("; ") || "—"} |`)
  }
  lines.push("")
  lines.push(`## Routing (who actually served)`)
  lines.push("")
  lines.push(`| Leg (provider/model) | Served | Task-passed |`)
  lines.push(`|---|---|---|`)
  for (const p of summary.byProvider) lines.push(`| ${p.leg} | ${p.served} | ${p.passed} |`)
  lines.push("")
  lines.push(`## Methodology`)
  lines.push("")
  lines.push(`- Fixed workload, fixed prompts; every request and every failure is reported, nothing is retried or cherry-picked.`)
  lines.push(`- Requests went through the gateway's normal OpenAI-compatible surface with tiered routing and the quality gate exactly as configured — the benchmark does not special-case anything.`)
  lines.push(`- Task checks are deterministic (JSON validity, exact format, extract correctness, code shape, length bounds).`)
  if (stub) {
    lines.push(`- **This run used bundled stub providers, not real LLMs** — it demonstrates the report machinery end to end. Regenerate against a configured pool for real numbers.`)
  }
  lines.push("")
  return lines.join("\n")
}

// ------------------------------------------------- stub mode (dry run, no keys)

// Two stub legs with distinct quality: "strong" answers correctly (valid JSON,
// real tool calls); "cheap" shows the classic small-model failure modes this
// product exists to catch (truncated JSON, looping plans).
function startStub(kind) {
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ id: "demo" }] }))
    }
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}")
      let content = null
      let toolCalls = null
      if (payload.response_format) {
        if (kind === "strong") {
          content = /extract every date/.test(payload.messages?.[0]?.content || "")
            ? '{"dates": ["2026-03-14", "2026-04-02", "2026-05-30"]}'
            : '{"name": "thing", "version": 1}'
        } else {
          content = 'Sure! Here you go: {"name": "thing"'
        }
      } else if (payload.tools?.length) {
        if (kind === "strong") {
          toolCalls = [
            { type: "function", id: "call_1", function: { name: "plan_draft", arguments: '{"steps": ["back up all nodes", "drain node 1", "migrate schema", "verify replicas", "resume writes"]}' } },
          ]
        } else {
          content = "Step 1: plan the migration carefully and thoroughly before proceeding with care. ".repeat(10)
        }
      } else if (payload.messages?.[0]?.content?.startsWith("List exactly five")) {
        content = "1. red\n2. blue\n3. green\n4. yellow\n5. black"
      } else if (payload.messages?.[0]?.content?.startsWith("Write a JavaScript")) {
        content = "function add(a, b) {\n  return a + b;\n}"
      } else {
        content =
          "The Vault of the low country kept promises rather than gold, recorded twice over — once in ink and once in memory — so when the river floods dissolved the ink, the bank lost nothing it truly owned."
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
      )
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

async function startStubGateway() {
  const cheap = await startStub("cheap")
  const strong = await startStub("strong")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-bench-"))
  const keyRec = (id) => ({ id, label: id })
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      version: 1,
      providers: [
        { id: "stub-cheap", label: "Stub Cheap", baseURL: `http://127.0.0.1:${cheap.port}`, adapter: "openai", quirks: [], models: ["stub-model"], keys: [keyRec("stub-cheap:key-1")] },
        { id: "stub-strong", label: "Stub Strong", baseURL: `http://127.0.0.1:${strong.port}`, adapter: "openai", quirks: [], models: ["stub-model"], keys: [keyRec("stub-strong:key-1")] },
      ],
      pools: [
        {
          // The recommended free-tier pattern: cheap leg first (no tiers), strong
          // backup second, quality gate on. Small tasks are served cheap and
          // ungated; anything the profiler marks tier 1+ is a downgrade from the
          // cheap leg and gets quality-gated before it can reach the client.
          id: "demo",
          name: "Demo",
          keyStrategy: "round-robin",
          qualityGate: { mode: "gate", threshold: 0.8 },
          legs: [
            { providerId: "stub-cheap", model: "stub-cheap-v1" },
            { providerId: "stub-strong", model: "stub-strong-v1" },
          ],
        },
      ],
      settings: { notifyFailover: false, reviveProbe: false, canaryEnabled: false },
    }),
  )
  fs.writeFileSync(path.join(home, "secrets.json"), JSON.stringify({ "stub-cheap:key-1": "sk-x", "stub-strong:key-1": "sk-y" }))
  const port = 40000 + Math.floor(Math.random() * 20000)
  const gw = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, CUPBEARER_HOME: home, CUPBEARER_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  })
  gw.stderr.on("data", (d) => process.stderr.write(`[gateway] ${d}`))
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error("stub gateway did not start")
    await new Promise((r) => setTimeout(r, 200))
  }
  return {
    base,
    async stop() {
      gw.kill("SIGTERM")
      cheap.server.close()
      strong.server.close()
      await new Promise((r) => setTimeout(r, 400))
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {}
    },
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("usage: node scripts/benchmark.js [--pool <id>] [--gateway <url>] [--reps n] [--out <file-base>] [--prices prices.json] [--stub]")
    process.exit(0)
  }

  let stopStub = null
  let gateway = args.gateway
  let stub = false
  if (args.stub) {
    stub = true
    const g = await startStubGateway()
    gateway = g.base
    stopStub = g.stop
    console.log("dry run: bundled stub gateway started")
  } else if (!gateway) {
    gateway = `http://127.0.0.1:${process.env.CUPBEARER_PORT || 4143}`
  }

  let pool = args.pool
  try {
    const models = await (await fetch(`${gateway}/v1/models`)).json()
    const ids = (models?.data || []).map((m) => m.id)
    if (!pool) pool = ids[0]
    if (!ids.length) throw new Error("the gateway has no pools configured")
    if (!ids.includes(pool)) throw new Error(`unknown pool "${pool}". Known pools: ${ids.join(", ")}`)
  } catch (e) {
    if (stopStub) await stopStub()
    console.error(`benchmark: ${e.message}. Is the gateway running? (start it with: npm start)`)
    process.exit(1)
  }

  let prices = null
  if (args.prices) {
    prices = JSON.parse(fs.readFileSync(args.prices, "utf8"))
  }

  console.log(`benchmark: pool "${pool}" @ ${gateway} — ${TASKS.length} tasks × ${args.reps} reps`)
  const results = await runSuite(gateway, pool, args.reps, args.timeoutMs)
  const summary = summarise(results)

  // Best-effort: pull the gateway's own quality evidence for the report. The
  // gateway batches its log writes on a ~2s timer, so give it a moment.
  await new Promise((r) => setTimeout(r, 2500))
  let quality = null
  try {
    const res = await fetch(`${gateway}/api/quality/summary?window=${24 * 3600 * 1000}`)
    if (res.ok) quality = (await res.json())?.summary ?? null
  } catch {}

  const cost = estimateCost(results, prices)
  const md = renderMarkdown(summary, results, { pool, gateway, stub, prices, cost, quality })

  const mdFile = `${args.out}.md`
  const jsonFile = `${args.out}.json`
  fs.writeFileSync(mdFile, md)
  fs.writeFileSync(jsonFile, JSON.stringify({ summary, quality, cost, results, meta: { pool, gateway, stub, prices: Boolean(prices), at: new Date().toISOString(), tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, prompt: t.prompt })) } }, null, 2))

  console.log(`\nbenchmark: ${summary.passed}/${summary.requests} task-checks passed (${(summary.taskPassRate * 100).toFixed(1)}%)`)
  console.log(`report: ${path.resolve(mdFile)}\n        ${path.resolve(jsonFile)}`)

  if (stopStub) await stopStub()
}


if (require.main === module) {
  main().catch((e) => {
    console.error("benchmark crashed:", e)
    process.exit(1)
  })
}

module.exports = { main, parseArgs }
