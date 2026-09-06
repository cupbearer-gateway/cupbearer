"use strict"

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const health = require("./health")
const { HEALTH_STATE_FILE } = require("./paths")

test("sticky health state persists and loads back", async () => {
  health.reset()

  // Mark key as exhausted
  health.markFailure("test-prov:k1", { reason: "budget_exhausted", keyState: "exhausted" })
  assert.equal(health.snapshot("test-prov:k1").state, "exhausted")

  health.flushStickySync()
  assert.ok(fs.existsSync(HEALTH_STATE_FILE))

  // Reset in-memory states map
  health.reset()

  // Snapshot should auto-load sticky state
  const snap = health.snapshot("test-prov:k1")
  assert.equal(snap.state, "exhausted")

  // Clear sticky state
  health.clearSticky()
  assert.equal(health.snapshot("test-prov:k1").state, "healthy")

  // Cleanup test file
  try {
    fs.unlinkSync(HEALTH_STATE_FILE)
  } catch {}
})
