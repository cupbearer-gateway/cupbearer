"use strict"
// DOC: ../docs/operations.md → § Background checks on healthy keys (canary) · ../docs/architecture.md → § Module map → server/canary.js
// Background canary probe of healthy keys.
//
// Quiet background checks on usable keys so degradation is noticed before user requests.
// Disabled by default (settings.canaryEnabled).

const config = require("./config")
const health = require("./health")
const upstream = require("./upstream")
const quirks = require("./quirks")
const { classify } = require("./classify")

let timer = null
let cursor = 0 // walks the target list across ticks so coverage spreads
let canaryStatus = {
  lastAt: null,
  totalProbed: 0,
  successes: 0,
  failures: 0,
  lastResult: null,
}

const MAX_PER_TICK = 3

// force=true is the dashboard's "check now" — an explicit ask should run even when
// the scheduled loop is switched off.
async function probeOnce({ force = false } = {}) {
  const cfg = config.load()
  if (!force && cfg.settings.canaryEnabled === false) return

  const targets = []
  const seen = new Set()
  for (const pool of cfg.pools) {
    for (const leg of pool.legs) {
      const provider = config.getProvider(leg.providerId)
      if (!provider || provider.enabled === false) continue
      for (const key of provider.keys || []) {
        // One entry per key, not per key × pool: a key shared by six pools would
        // otherwise soak up every probe and the rest would never be checked.
        if (seen.has(key.id)) continue
        const snap = health.snapshot(key.id)
        if (snap.usable && !snap.sticky && snap.state !== "cooling") {
          seen.add(key.id)
          targets.push({ pool, provider, key, model: leg.model })
        }
      }
    }
  }

  if (!targets.length) return

  // A few per tick, continuing where the last tick stopped. Slicing from 0 every
  // time would re-probe the same three keys forever and never see the rest.
  const sample = []
  for (let i = 0; i < Math.min(MAX_PER_TICK, targets.length); i++) {
    sample.push(targets[(cursor + i) % targets.length])
  }
  cursor = (cursor + sample.length) % targets.length

  for (const target of sample) {
    const { provider, key, model } = target
    const applied = quirks.compose(provider.quirks || [])

    const out = await upstream
      .callJson({
        provider,
        keyId: key.id,
        model,
        payload: { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
        applied,
        timeoutMs: 15000,
      })
      .catch(() => ({ ok: false }))

    canaryStatus.lastAt = Date.now()
    canaryStatus.totalProbed++

    if (out.ok) {
      health.markSuccess(key.id, { latencyMs: out.latencyMs }, model)
      canaryStatus.successes++
      canaryStatus.lastResult = `OK (${out.latencyMs}ms) on ${provider.id}`
    } else {
      const verdict = classify({ status: out.status, body: out.body, error: out.error })
      // Don't pull a key for request-scoped errors on canary
      if (verdict.reason !== "context_too_long" && verdict.reason !== "content_filtered") {
        health.markFailure(key.id, verdict, model)
      }
      canaryStatus.failures++
      canaryStatus.lastResult = `Fail (${verdict.reason}) on ${provider.id}`
    }
  }
}

function start() {
  stop() // idempotent: never stack timers when settings change or start is re-called
  const cfg = config.load()
  if (!cfg.settings.canaryEnabled) return

  const minutes = cfg.settings.canaryIntervalMinutes || 15
  timer = setInterval(() => {
    probeOnce().catch(() => {})
  }, minutes * 60000)
  if (timer.unref) timer.unref()
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

function getStatus() {
  return canaryStatus
}

module.exports = { start, stop, probeOnce, getStatus }
