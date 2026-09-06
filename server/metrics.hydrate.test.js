"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const path = require("path")
const metrics = require("./metrics")
const { METRICS_DIR } = require("./paths")

test("dashboard stats hydrate from JSONL after an in-memory reset (fake restart)", () => {
  metrics.reset()

  // Write a row into a file the live server will never append to (tomorrow).
  const d = new Date(Date.now() + 24 * 3600 * 1000)
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const file = path.join(METRICS_DIR, `calls-${stamp}.jsonl`)
  const row = {
    at: Date.now() - 1000,
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
  }

  fs.mkdirSync(METRICS_DIR, { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8")
  try {
    // Fresh process state: summary should include the JSONL row
    const summary = metrics.poolSummary("hydrate-test", 24 * 3600 * 1000)
    assert.equal(summary.calls, 1)
    assert.equal(summary.successes, 1)
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {}
    metrics.reset()
  }
})
