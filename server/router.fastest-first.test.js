"use strict"

const test = require("node:test")
const assert = require("node:assert")
const health = require("./health")
const secrets = require("./secrets")
const router = require("./router")

test("fastest-first key strategy orders lower latency and higher success rate first", () => {
  const provider = {
    id: "test-prov-fast",
    keys: [{ id: "test-prov-fast:k1" }, { id: "test-prov-fast:k2" }, { id: "test-prov-fast:k3" }],
  }

  const origHas = secrets.has
  secrets.has = () => true // stub: avoid touching the real secrets file
  const origCalls = {}
  for (const k of provider.keys) {
    origCalls[k.id] = health.snapshot(k.id)
  }

  // Register calls so calls >= 2
  for (const k of provider.keys) {
    health.markUsed(k.id)
    health.markUsed(k.id)
  }

  // k1: slow (8000ms), k2: fast (500ms), k3: medium (2000ms)
  health.markSuccess("test-prov-fast:k1", { latencyMs: 8000 })
  health.markSuccess("test-prov-fast:k2", { latencyMs: 500 })
  health.markSuccess("test-prov-fast:k3", { latencyMs: 2000 })

  const ordered = router.orderedKeys(provider, "fastest-first")
  assert.equal(ordered[0], "test-prov-fast:k2", "Fastest key k2 should be tried first")
  assert.equal(ordered[ordered.length - 1], "test-prov-fast:k1", "Slowest key k1 should be reserve/last")

  secrets.has = origHas
  health.reset()
})
