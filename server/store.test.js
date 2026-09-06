"use strict"

// Isolation: point CUPBEARER_HOME at a throwaway dir BEFORE any server module
// computes its paths. node --test runs each file in its own process, so this
// never leaks into other test files.
const os = require("os")
const fs = require("fs")
const path = require("path")
process.env.CUPBEARER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-store-test-"))

const test = require("node:test")
const assert = require("node:assert")
const store = require("./store")

test.afterEach(() => {
  store.reset()
})

test("requests round-trip through the SQLite log", () => {
  store.appendRequest({ poolId: "t", providerId: "p", keyId: "p:k", model: "m", ok: true, latencyMs: 42, status: 200, tokensIn: 3, tokensOut: 5, attempts: 1, streamed: false })
  store.flush()
  const rows = store.hydrateRows(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].poolId, "t")
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].tokensOut, 5)
})

test("decisions round-trip with breakdown and judge payloads", () => {
  store.appendDecision({
    poolId: "t",
    kind: "gate",
    mode: "gate",
    providerId: "p",
    model: "m",
    requiredTier: 1,
    servedTier: 3,
    downgrade: true,
    score: 0.42,
    threshold: 0.8,
    passed: false,
    breakdownJson: JSON.stringify([{ id: "repetition", score: 0, reason: "loop" }]),
    judgeJson: null,
    detail: "output is looping",
  })
  store.flush()
  const rows = store.recentDecisions(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].passed, false)
  assert.equal(rows[0].downgrade, true)
  assert.equal(rows[0].breakdown[0].id, "repetition")
})

test("qualitySummary aggregates the gate evidence honestly", () => {
  const mk = (mode, passed, downgrade, detail) =>
    store.appendDecision({ poolId: "s", kind: "gate", mode, downgrade, score: passed ? 0.95 : 0.3, threshold: 0.8, passed, detail })
  mk("gate", true, true)
  mk("gate", true, true)
  mk("gate", false, true, "output is looping")
  mk("shadow", false, false, "empty response")
  store.flush()
  const s = store.qualitySummary({ poolId: "s" })
  assert.equal(s.decisions, 4)
  assert.equal(s.gate.decisions, 3)
  assert.equal(s.gate.passed, 2)
  assert.equal(s.gate.qualityHold, 2 / 3)
  assert.equal(s.shadow.decisions, 1)
  assert.deepEqual(s.failureReasons.map((r) => r.reason), ["output is looping", "empty response"])
})

test("prune drops rows older than the retention window", () => {
  store.appendRequest({ poolId: "old", ok: true })
  store.flush()
  const db = require("node:sqlite")
  // Age every row past a 1-day window by rewriting ts directly.
  const d = new db.DatabaseSync(require("./paths").METRICS_DIR + "/cupbearer.db")
  d.exec("PRAGMA busy_timeout = 5000")
  d.prepare("UPDATE requests SET ts = ?").run(Date.now() - 3 * 24 * 3600 * 1000)
  d.close()
  store.prune(1)
  assert.equal(store.hydrateRows(10).length, 0)
})
