"use strict"
// DOC: ../docs/architecture.md → § Module map → server/metrics.js
//
// Metrics: an in-memory rolling window for the dashboard, persisted to SQLite
// (store.js) so history survives restarts. Writes are queued and flushed on a
// timer rather than per-call, so a slow disk never delays a model request.

const WINDOW = 2000 // recent calls kept in memory

const store = require("./store")

const recent = []

// Fresh process state: seed the window from the SQLite log.
function hydrate() {
  try {
    const rows = store.hydrateRows(WINDOW)
    recent.length = 0
    for (const r of rows) recent.push(r)
  } catch {}
}

// Prune old log rows once a day. Never on the request path.
let retentionTimer = null
function scheduleRetention() {
  if (retentionTimer) return
  const run = () => {
    const cfg = require("./config").load()
    store.prune(cfg.settings.storeRetainDays ?? 30)
  }
  run()
  retentionTimer = setInterval(run, 24 * 3600 * 1000)
  if (retentionTimer.unref) retentionTimer.unref()
}

function flush() {
  store.flush()
}

/**
 * Record one finished call. Also the landing point for quality-gate outcomes:
 * a gated downgrade that fails logs ok:false with reason "quality_gate_failed".
 * @param {object} call
 * @param {string} call.poolId
 * @param {string} call.providerId
 * @param {string} call.keyId
 * @param {string} call.model
 * @param {boolean} call.ok
 * @param {number} call.latencyMs
 * @param {number} [call.status]
 * @param {string} [call.reason]
 * @param {string} [call.message]
 * @param {number} [call.tokensIn]
 * @param {number} [call.tokensOut]
 * @param {number} [call.attempts]  how many legs/keys were tried
 * @param {boolean} [call.streamed]
 * @param {number} [call.score]     quality score when the gate evaluated it
 */
function record(call) {
  const row = { at: Date.now(), ...call }
  recent.push(row)
  if (recent.length > WINDOW) recent.shift()
  store.appendRequest({ ...call })
  return row
}

function since(ms) {
  const cutoff = Date.now() - ms
  return recent.filter((r) => r.at >= cutoff)
}

function summarise(rows) {
  const calls = rows.length
  const ok = rows.filter((r) => r.ok).length
  const latencies = rows.filter((r) => r.ok && typeof r.latencyMs === "number").map((r) => r.latencyMs).sort((a, b) => a - b)
  const pick = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : null)
  const scored = rows.filter((r) => typeof r.score === "number")
  return {
    calls,
    successes: ok,
    failures: calls - ok,
    successRate: calls ? ok / calls : null,
    tokensIn: rows.reduce((n, r) => n + (r.tokensIn || 0), 0),
    tokensOut: rows.reduce((n, r) => n + (r.tokensOut || 0), 0),
    p50Ms: pick(50),
    p95Ms: pick(95),
    failoverRate: calls ? rows.filter((r) => (r.attempts || 1) > 1).length / calls : null,
    gateEvaluated: scored.length,
    gateAvgScore: scored.length ? scored.reduce((n, r) => n + r.score, 0) / scored.length : null,
  }
}

function poolSummary(poolId, windowMs = 24 * 60 * 60 * 1000) {
  return summarise(since(windowMs).filter((r) => r.poolId === poolId))
}

function overall(windowMs = 24 * 60 * 60 * 1000) {
  return summarise(since(windowMs))
}

// Newest first, for the dashboard's live feed.
function feed(limit = 50, poolId = null) {
  const rows = poolId ? recent.filter((r) => r.poolId === poolId) : recent
  return rows.slice(-limit).reverse()
}

// Per-minute buckets for sparklines.
function series(poolId, minutes = 60) {
  const now = Date.now()
  const buckets = new Array(minutes).fill(null).map(() => ({ calls: 0, failures: 0, latencySum: 0, latencyN: 0 }))
  for (const r of recent) {
    const age = now - r.at
    if (age < 0 || age > minutes * 60000) continue
    if (poolId && r.poolId !== poolId) continue
    const idx = minutes - 1 - Math.floor(age / 60000)
    if (idx < 0 || idx >= minutes) continue
    const b = buckets[idx]
    b.calls++
    if (!r.ok) b.failures++
    if (r.ok && typeof r.latencyMs === "number") {
      b.latencySum += r.latencyMs
      b.latencyN++
    }
  }
  return buckets.map((b) => ({
    calls: b.calls,
    failures: b.failures,
    avgLatencyMs: b.latencyN ? Math.round(b.latencySum / b.latencyN) : null,
  }))
}

function shutdown() {
  store.shutdown()
}

function reset() {
  recent.length = 0
  store.reset()
}

module.exports = {
  record,
  poolSummary,
  overall,
  feed,
  series,
  since,
  summarise,
  shutdown,
  reset,
  hydrate,
  flush,
  scheduleRetention,
}
