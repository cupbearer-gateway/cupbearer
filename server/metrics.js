"use strict"
// DOC: ../docs/architecture.md → § Module map → server/metrics.js

// Metrics: in-memory rolling window for the dashboard, plus an append-only
// JSONL log so history survives restarts.
//
// Writes are queued and flushed on a timer rather than per-call, so a slow disk
// never delays a model request.

const fs = require("fs")
const path = require("path")
const { METRICS_DIR } = require("./paths")

const WINDOW = 2000 // recent calls kept in memory
const FLUSH_MS = 2000

const recent = []
let pending = []
let flushTimer = null
let recentHydrated = false

function hydrate() {
  if (recentHydrated) return
  recentHydrated = true
  try {
    if (!fs.existsSync(METRICS_DIR)) return
    const files = fs.readdirSync(METRICS_DIR).filter((f) => f.startsWith("calls-") && f.endsWith(".jsonl")).sort()
    // Load last 2 days of logs into memory
    const targetFiles = files.slice(-2)
    for (const f of targetFiles) {
      const content = fs.readFileSync(path.join(METRICS_DIR, f), "utf8")
      const lines = content.split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          const row = JSON.parse(line)
          recent.push(row)
          if (recent.length > WINDOW) recent.shift()
        } catch {}
      }
    }
  } catch {}
}

function retention(maxDays = 14) {
  try {
    if (!fs.existsSync(METRICS_DIR)) return
    const cutoffMs = Date.now() - maxDays * 24 * 3600 * 1000
    const files = fs.readdirSync(METRICS_DIR).filter((f) => f.startsWith("calls-") && f.endsWith(".jsonl"))
    for (const f of files) {
      const fp = path.join(METRICS_DIR, f)
      const stat = fs.statSync(fp)
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(fp)
      }
    }
  } catch {}
}

// Prune old call logs once a day. Never on the request path.
let retentionTimer = null
function scheduleRetention() {
  if (retentionTimer) return
  const run = () => {
    const cfg = require("./config").load()
    retention(cfg.settings.metricsRetainDays ?? 14)
  }
  run()
  retentionTimer = setInterval(run, 24 * 3600 * 1000)
  if (retentionTimer.unref) retentionTimer.unref()
}

function logFile(d = new Date()) {
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  return path.join(METRICS_DIR, `calls-${stamp}.jsonl`)
}

function flush() {
  flushTimer = null
  if (!pending.length) return
  const batch = pending
  pending = []
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true })
    fs.appendFileSync(logFile(), batch.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
  } catch {
    // Metrics are diagnostics, never a reason to fail a request.
  }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
  if (flushTimer.unref) flushTimer.unref()
}

/**
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
 */
function record(call) {
  const row = { at: Date.now(), ...call }
  recent.push(row)
  if (recent.length > WINDOW) recent.shift()
  pending.push(row)
  scheduleFlush()
  return row
}

function since(ms) {
  hydrate()
  const cutoff = Date.now() - ms
  return recent.filter((r) => r.at >= cutoff)
}

function summarise(rows) {
  const calls = rows.length
  const ok = rows.filter((r) => r.ok).length
  const latencies = rows.filter((r) => r.ok && typeof r.latencyMs === "number").map((r) => r.latencyMs).sort((a, b) => a - b)
  const pick = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : null)
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
  if (flushTimer) clearTimeout(flushTimer)
  flush()
}

function reset() {
  recent.length = 0
  pending = []
  recentHydrated = false
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
  retention,
  scheduleRetention,
}
