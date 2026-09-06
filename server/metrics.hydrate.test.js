"use strict"

const os = require("os")
const fs = require("fs")
const path = require("path")
process.env.CUPBEARER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-hydrate-test-"))

const test = require("node:test")
const assert = require("node:assert")
const metrics = require("./metrics")
const store = require("./store")

test("dashboard stats hydrate from the SQLite log after an in-memory reset (fake restart)", () => {
  metrics.reset()
  store.appendRequest({
    poolId: "hydrate-test",
    providerId: "hp",
    keyId: "hp:k1",
    model: "m",
    ok: true,
    latencyMs: 120,
    attempts: 1,
    streamed: false,
    tokensIn: 10,
    tokensOut: 5,
  })
  store.flush()
  metrics.hydrate()
  try {
    const summary = metrics.poolSummary("hydrate-test", 24 * 3600 * 1000)
    assert.equal(summary.calls, 1)
    assert.equal(summary.successes, 1)
    assert.equal(summary.tokensOut, 5)
  } finally {
    metrics.reset()
  }
})
