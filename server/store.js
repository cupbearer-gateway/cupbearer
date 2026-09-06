"use strict"
// DOC: ../docs/architecture.md → § Storage
//
// SQLite persistence for the request log and quality decisions. Backed by
// node:sqlite (DatabaseSync), which ships with Node >= 22 — zero native
// dependencies, nothing to compile. Writes are queued and flushed off the
// request path; the in-memory rolling window in metrics.js stays the hot read
// path for the dashboard. Losing the buffer to a crash costs a couple of
// seconds of diagnostics, never a request.

const fs = require("fs")
const path = require("path")
const { DatabaseSync } = require("node:sqlite")
const { METRICS_DIR } = require("./paths")

const FLUSH_MS = 2000
const DB_FILE = path.join(METRICS_DIR, "cupbearer.db")

let db = null
let pendingRequests = []
let pendingDecisions = []
let flushTimer = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  model_requested TEXT,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  attempts INTEGER,
  attempts_json TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  streamed INTEGER DEFAULT 0,
  provider_id TEXT,
  key_id TEXT,
  model TEXT,
  reason TEXT,
  message TEXT,
  profile_json TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT,
  provider_id TEXT,
  model TEXT,
  required_tier INTEGER,
  served_tier INTEGER,
  downgrade INTEGER,
  score REAL,
  threshold REAL,
  passed INTEGER,
  breakdown_json TEXT,
  judge_json TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_pool_ts ON requests(pool_id, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
CREATE INDEX IF NOT EXISTS idx_decisions_pool_ts ON decisions(pool_id, ts);
`

function init() {
  if (db) return db
  fs.mkdirSync(METRICS_DIR, { recursive: true })
  db = new DatabaseSync(DB_FILE)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(SCHEMA)
  return db
}

function flush() {
  flushTimer = null
  if (!pendingRequests.length && !pendingDecisions.length) return
  const reqs = pendingRequests
  const decs = pendingDecisions
  pendingRequests = []
  pendingDecisions = []
  try {
    const d = init()
    if (reqs.length) {
      const stmt = d.prepare(
        `INSERT INTO requests (ts, pool_id, model_requested, ok, status, latency_ms, attempts, attempts_json, tokens_in, tokens_out, streamed, provider_id, key_id, model, reason, message, profile_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const r of reqs) {
        stmt.run(
          r.at, r.poolId, r.modelRequested ?? null, r.ok ? 1 : 0, r.status ?? null, r.latencyMs ?? null,
          r.attempts ?? null, r.attemptsJson ?? null, r.tokensIn ?? 0, r.tokensOut ?? 0, r.streamed ? 1 : 0,
          r.providerId ?? null, r.keyId ?? null, r.model ?? null, r.reason ?? null, r.message ?? null, r.profileJson ?? null,
        )
      }
    }
    if (decs.length) {
      const stmt = d.prepare(
        `INSERT INTO decisions (ts, pool_id, kind, mode, provider_id, model, required_tier, served_tier, downgrade, score, threshold, passed, breakdown_json, judge_json, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const c of decs) {
        stmt.run(
          c.ts, c.poolId, c.kind, c.mode ?? null, c.providerId ?? null, c.model ?? null,
          c.requiredTier ?? null, c.servedTier ?? null, c.downgrade ? 1 : 0, c.score ?? null, c.threshold ?? null,
          c.passed ? 1 : 0, c.breakdownJson ?? null, c.judgeJson ?? null, c.detail ?? null,
        )
      }
    }
  } catch {
    // Logging is diagnostics, never a reason to fail a request. The batch is
    // dropped; the in-memory window in metrics.js still holds recent rows.
  }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
  if (flushTimer.unref) flushTimer.unref()
}

function appendRequest(row) {
  pendingRequests.push({ at: Date.now(), ...row })
  scheduleFlush()
}

function appendDecision(row) {
  pendingDecisions.push({ ts: Date.now(), ...row })
  scheduleFlush()
}

function mapRequestRow(r) {
  return {
    at: r.ts,
    poolId: r.pool_id,
    modelRequested: r.model_requested,
    ok: Boolean(r.ok),
    status: r.status,
    latencyMs: r.latency_ms,
    attempts: r.attempts,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    streamed: Boolean(r.streamed),
    providerId: r.provider_id,
    keyId: r.key_id,
    model: r.model,
    reason: r.reason,
    message: r.message,
  }
}

// Seed the in-memory window after a restart: the dashboard keeps its history.
function hydrateRows(windowSize) {
  const d = init()
  return d.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT ?").all(windowSize).reverse().map(mapRequestRow)
}

function recentDecisions(limit = 100, poolId = null) {
  const d = init()
  const rows = poolId
    ? d.prepare("SELECT * FROM decisions WHERE pool_id = ? ORDER BY id DESC LIMIT ?").all(poolId, limit)
    : d.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(limit)
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    poolId: r.pool_id,
    kind: r.kind,
    mode: r.mode,
    providerId: r.provider_id,
    model: r.model,
    requiredTier: r.required_tier,
    servedTier: r.served_tier,
    downgrade: Boolean(r.downgrade),
    score: r.score,
    threshold: r.threshold,
    passed: Boolean(r.passed),
    breakdown: safeParse(r.breakdown_json),
    judge: safeParse(r.judge_json),
    detail: r.detail,
  }))
}

// Aggregate gate evidence over a window. `qualityHold` is the number the
// benchmark reports: of the gated downgrade attempts, how many held up.
function qualitySummary({ poolId = null, windowMs = 24 * 3600 * 1000 } = {}) {
  const d = init()
  const since = Date.now() - windowMs
  const base = poolId ? "WHERE pool_id = ? AND ts >= ?" : "WHERE ts >= ?"
  const args = poolId ? [poolId, since] : [since]
  const row = d
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(passed), 0) passed_n, AVG(score) avg_score, COALESCE(SUM(downgrade), 0) downgrades FROM decisions ${base}`)
    .get(...args)
  const gated = d
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(passed), 0) passed_n FROM decisions ${base} AND mode = 'gate'`)
    .get(...args)
  const shadow = d
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(passed), 0) passed_n FROM decisions ${base} AND mode = 'shadow'`)
    .get(...args)
  const byReason = d
    .prepare(
      `SELECT detail reason, COUNT(*) n FROM decisions ${base} AND passed = 0 AND detail IS NOT NULL GROUP BY detail ORDER BY n DESC LIMIT 10`,
    )
    .all(...args)
  return {
    decisions: row.n,
    passed: row.passed_n,
    failed: row.n - row.passed_n,
    avgScore: row.avg_score,
    downgrades: row.downgrades,
    gate: { decisions: gated.n, passed: gated.passed_n, qualityHold: gated.n ? gated.passed_n / gated.n : null },
    shadow: { decisions: shadow.n, passed: shadow.passed_n },
    failureReasons: byReason,
  }
}

function prune(maxDays) {
  const cutoff = Date.now() - maxDays * 24 * 3600 * 1000
  try {
    const d = init()
    d.prepare("DELETE FROM requests WHERE ts < ?").run(cutoff)
    d.prepare("DELETE FROM decisions WHERE ts < ?").run(cutoff)
  } catch {}
}

function shutdown() {
  if (flushTimer) clearTimeout(flushTimer)
  flush()
}

function clear() {
  try {
    const d = init()
    d.prepare("DELETE FROM requests").run()
    d.prepare("DELETE FROM decisions").run()
  } catch {}
  pendingRequests = []
  pendingDecisions = []
}

function reset() {
  pendingRequests = []
  pendingDecisions = []
  if (db) {
    try {
      db.close()
    } catch {}
    db = null
  }
}

function safeParse(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

module.exports = { appendRequest, appendDecision, recentDecisions, qualitySummary, hydrateRows, prune, flush, shutdown, reset, clear, DB_FILE }
