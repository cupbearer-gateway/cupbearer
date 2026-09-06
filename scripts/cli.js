#!/usr/bin/env node
"use strict"
// Cupbearer CLI — the one-command experience.
//
//   cupbearer setup    guided provider + key + pool wizard (writes config +
//                      secrets, verifies every key with a 1-token probe)
//   cupbearer serve    start the gateway (same as: node server/index.js)
//   cupbearer doctor   config sanity, key presence, optional live probes
//
// The wizard never sends a key anywhere except to the provider it belongs to.
// A probe call costs a token or two of the user's own quota — it is how the
// wizard proves the key works before writing anything to disk.
//
// Input handling: interactive readline on a TTY; when stdin is piped (scripted
// installs, CI), all lines are read up front and served from a queue — Node's
// promise readline drops sequential questions on non-TTY input.

const readline = require("readline/promises")
const fs = require("fs")
const path = require("path")

const presets = require("../server/presets")
const paths = require("../server/paths")
const config = require("../server/config")
const secrets = require("../server/secrets")
const health = require("../server/health")
const quirks = require("../server/quirks")
const upstream = require("../server/upstream")
const { classify } = require("../server/classify")

// ------------------------------------------------------------------ helpers

function line(text = "") {
  console.log(text)
}

// One input source per command. Same ask() contract for TTY and piped modes.
function makeInput() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return {
      async ask(question, fallback = "") {
        const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim()
        return answer || fallback
      },
      close() {
        rl.close()
      },
    }
  }
  const lines = fs.readFileSync(0, "utf8").split(/\r?\n/)
  let i = 0
  return {
    async ask(question, fallback = "") {
      process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ""}: `)
      const answer = (lines[i++] ?? "").trim()
      console.log(answer)
      return answer || fallback
    },
    close() {},
  }
}

function maskKey(v) {
  if (!v) return "(empty)"
  if (v.length <= 12) return `${v.slice(0, 3)}…`
  return `${v.slice(0, 6)}…${v.slice(-4)}`
}

// Minimal .env reader: KEY=VALUE lines, # comments, optional quotes.
function readEnvFile(file) {
  const out = {}
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return out
  }
  for (const raw of text.split("\n")) {
    const l = raw.trim()
    if (!l || l.startsWith("#")) continue
    const eq = l.indexOf("=")
    if (eq === -1) continue
    const key = l.slice(0, eq).trim()
    let value = l.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (key) out[key] = value
  }
  return out
}

// One ~1-token live call against (provider, model).
async function probe(provider, keyId, model) {
  const applied = quirks.compose(provider.quirks || [])
  const out = await upstream.callJson({
    provider,
    keyId,
    model,
    payload: { messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
    applied,
    timeoutMs: 30000,
  })
  if (out.ok) return { ok: true, latencyMs: out.latencyMs }
  const verdict = classify({ status: out.status, body: out.body, error: out.error })
  return { ok: false, reason: verdict.reason, message: verdict.message }
}

// ------------------------------------------------------------------ setup

async function setup() {
  const input = makeInput()
  const env = { ...readEnvFile(path.join(process.cwd(), ".env")), ...process.env }

  line("")
  line("Cupbearer setup — bring your own keys, we do the rest.")
  line(`Everything stays on this machine: config in ${paths.CONFIG_FILE}`)
  line("")

  const existing = (() => {
    try {
      return config.load()
    } catch (e) {
      line(`warning: could not parse existing config (${e.message}); starting fresh`)
      return { providers: [], pools: [], settings: {} }
    }
  })()

  // ---- 1. providers ----------------------------------------------------
  const choices = presets.list()
  line("Which providers do you want to pool? (comma-separated numbers, e.g. 1,3)")
  choices.forEach((p, i) => line(`  ${i + 1}. ${p.label}  — key: ${p.keyEnv} (${p.keyDocs})`))
  line(`  ${choices.length + 1}. Custom OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, …)`)
  const pickedRaw = await input.ask("Providers", "1")
  const pickedIdx = pickedRaw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length + 1)

  if (!pickedIdx.length) {
    line("No providers selected — nothing to do.")
    input.close()
    return
  }

  const configured = []
  for (const n of pickedIdx) {
    line("")
    if (n <= choices.length) {
      const p = choices[n - 1]
      line(`— ${p.label} —`)
      const envValue = env[p.keyEnv] || ""
      const keyValue = await input.ask(`API key (from ${p.keyEnv}${envValue ? `, found: ${maskKey(envValue)}` : " not set"})`, "")
      const value = keyValue || envValue
      if (!value) {
        line("  no key provided — skipping this provider")
        continue
      }
      const provider = { id: p.id, label: p.label, baseURL: p.baseURL, adapter: "openai", quirks: p.quirks ? [...p.quirks] : [], models: [...p.models], keys: [{ id: `${p.id}:key-1`, label: "Key 1" }] }

      // Prove the key works before storing anything.
      secrets.set(`${p.id}:key-1`, value)
      line("  probing with a 1-token call…")
      const result = await probe(provider, `${p.id}:key-1`, p.models[0])
      if (result.ok) {
        line(`  key works (${result.latencyMs}ms)`)
      } else {
        line(`  probe failed: ${result.reason} — ${result.message || ""}`)
        const keep = await input.ask("Store it anyway? (y/N)", "N")
        if (!/^y/i.test(keep)) {
          secrets.remove(`${p.id}:key-1`)
          continue
        }
      }
      // Offer live model discovery now that we know the key works.
      const discover = await input.ask("Fetch the live model list from the provider? (Y/n)", "Y")
      if (/^y/i.test(discover)) {
        const listed = await upstream.listModels({ provider, keyId: `${p.id}:key-1` })
        if (listed.ok && listed.models.length) {
          provider.models = listed.models
          line(`  ${listed.models.length} models discovered`)
        } else {
          line(`  discovery failed (${listed.error?.message || listed.status || "no models"}) — keeping the starter list`)
        }
      }
      configured.push({ provider, tier: p.starterTier })
    } else {
      line("— Custom OpenAI-compatible endpoint —")
      const id = (await input.ask("Short id (letters/digits/dash)", "custom")).replace(/[^a-zA-Z0-9-]/g, "-") || "custom"
      const label = await input.ask("Label", id)
      const baseURL = await input.ask("Base URL (…/v1)", "http://127.0.0.1:11434/v1")
      const model = await input.ask("Model id", "llama3.1")
      const keyValue = await input.ask("API key (empty if the endpoint needs none)", "")
      const provider = { id, label, baseURL, adapter: "openai", quirks: [], models: [model], keys: [{ id: `${id}:key-1`, label: "Key 1" }] }
      if (keyValue) secrets.set(`${id}:key-1`, keyValue)
      configured.push({ provider, tier: null })
    }
  }

  if (!configured.length) {
    line("")
    line("No providers configured — nothing written. Run `cupbearer setup` again anytime.")
    input.close()
    return
  }

  // ---- 2. pool ---------------------------------------------------------
  line("")
  const poolName = await input.ask("Pool name (what clients will call as the model)", "smart")
  const poolId = config.slugify(poolName) || "smart"
  line("")
  line("Quality gate:")
  line("  1. shadow (recommended) — route on quality evidence, never block; builds the report")
  line("  2. gate — a downgrade that fails evaluation is blocked and rerouted to a stronger leg")
  line("  3. off — availability-only routing")
  const gateChoice = await input.ask("Gate mode", "1")
  const gateMode = gateChoice === "2" ? "gate" : gateChoice === "3" ? "off" : "shadow"

  // Cheap-first: lighter starter tiers before stronger ones; undeclared last.
  // The first leg is the one that serves most requests; stronger legs back it
  // up and receive anything the quality gate reroutes.
  const ordered = [...configured].sort((a, b) => (b.tier ?? 3) - (a.tier ?? 3))
  const pool = {
    id: poolId,
    name: poolName,
    keyStrategy: "round-robin",
    qualityGate: { mode: gateMode, threshold: 0.8 },
    legs: ordered.map(({ provider }) => ({ providerId: provider.id, model: provider.models[0] })),
  }

  // ---- 3. write --------------------------------------------------------
  const next = {
    version: config.DEFAULT_CONFIG.version,
    providers: [...existing.providers.filter((p) => !configured.some((c) => c.provider.id === p.id)), ...configured.map((c) => c.provider)],
    pools: [...existing.pools.filter((p) => p.id !== poolId), pool],
    settings: { ...config.DEFAULT_CONFIG.settings, ...(existing.settings || {}) },
  }
  config.save(next)
  health.clearSticky()

  line("")
  line("Written:")
  line(`  ${paths.CONFIG_FILE}  (${next.providers.length} provider(s), ${next.pools.length} pool(s))`)
  line(`  ${paths.SECRETS_FILE} (locked to your user account)`)
  line("")
  line("Start the gateway:   cupbearer serve   (or: npm start)")
  line(`Dashboard:           http://${paths.HOST}:${paths.PORT}`)
  line(`Endpoint:            http://${paths.HOST}:${paths.PORT}/v1/chat/completions  — model: "${poolId}"`)
  line("")
  line("Point any OpenAI-speaking client at it, or connect an agent:")
  line(`  Claude Code:  ANTHROPIC_BASE_URL=http://${paths.HOST}:${paths.PORT} (see README for the exact snippet)`)
  line(`  Cursor:       Override OpenAI Base URL → http://${paths.HOST}:${paths.PORT}/v1`)
  line("")
  if (gateMode === "shadow") {
    line('The gate is in shadow mode: it scores every response and logs the evidence without blocking. Switch to "gate" in the dashboard (or set qualityGate.mode) when the numbers convince you.')
  }
  input.close()
}

// ------------------------------------------------------------------ doctor

async function doctor() {
  const input = makeInput()
  line("")
  line(`Cupbearer doctor — ${paths.CONFIG_FILE}`)
  let ok = true

  let cfg
  try {
    cfg = config.load()
    line(`  ok   config parses (${cfg.providers.length} provider(s), ${cfg.pools.length} pool(s))`)
  } catch (e) {
    line(`  FAIL config unreadable: ${e.message}`)
    input.close()
    process.exit(1)
  }

  if (!cfg.providers.length) {
    line("  --   no providers yet — run: cupbearer setup")
    input.close()
    return
  }

  for (const p of cfg.providers) {
    const withSecrets = (p.keys || []).filter((k) => secrets.has(k.id))
    const usable = withSecrets.filter((k) => health.isUsable(k.id))
    line(`  ${p.enabled === false ? "--" : "ok  "} provider "${p.id}" — ${withSecrets.length}/${(p.keys || []).length} key(s) stored, ${usable.length} usable`)
    if (!withSecrets.length) ok = false
  }

  for (const pool of cfg.pools) {
    const dead = pool.legs.filter((l) => {
      const provider = cfg.providers.find((x) => x.id === l.providerId)
      return !provider || provider.enabled === false
    })
    line(`  ${dead.length ? "warn" : "ok  "} pool "${pool.id}" — ${pool.legs.length} leg(s)${dead.length ? `, ${dead.length} dangling` : ""}${pool.qualityGate?.mode ? `, gate: ${pool.qualityGate.mode}` : ""}`)
  }

  const probeArg = process.argv.includes("--probe")
  if (probeArg) {
    for (const p of cfg.providers) {
      for (const k of p.keys || []) {
        if (!secrets.has(k.id)) continue
        const model = p.models?.[0]
        if (!model) continue
        const result = await probe(p, k.id, model)
        line(`  ${result.ok ? "ok  " : "FAIL"} probe ${p.id}/${model} via ${k.id}${result.ok ? ` (${result.latencyMs}ms)` : ` — ${result.reason}: ${result.message || ""}`}`)
        if (!result.ok) ok = false
      }
    }
  } else {
    line("  --   add --probe to test every key with a 1-token live call")
  }

  line("")
  line(ok ? "all checks passed" : "issues found — see the FAIL/warn lines above")
  if (!ok) process.exitCode = 1
  input.close()
}

// ------------------------------------------------------------------ main

async function main() {
  const command = process.argv[2] || "help"

  try {
    if (command === "setup") {
      await setup()
    } else if (command === "serve" || command === "start") {
      require("../server/index.js")
    } else if (command === "doctor") {
      await doctor()
    } else {
      line("cupbearer — the LLM gateway that never hands your task to a model that can't handle it")
      line("")
      line("  cupbearer setup    guided provider + key + pool setup")
      line("  cupbearer serve    start the gateway")
      line("  cupbearer doctor   check config, keys, and (with --probe) live upstreams")
      line("")
      if (!["help", "-h", "--help"].includes(command)) {
        line(`unknown command: ${command}`)
        process.exitCode = 1
      }
    }
  } catch (e) {
    console.error(`cupbearer: ${e.message}`)
    process.exitCode = 1
  }
}

main()
