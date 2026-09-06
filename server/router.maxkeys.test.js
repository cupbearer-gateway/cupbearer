"use strict"

const test = require("node:test")
const assert = require("node:assert")
const health = require("./health")
const secrets = require("./secrets")
const config = require("./config")
const router = require("./router")

test("maxKeysPerLeg caps how many keys a request will try on one provider", () => {
  const origLoad = config.load
  config.load = () => ({
    settings: { maxKeysPerLeg: 3 },
    providers: [],
    pools: [],
  })

  const origHas = secrets.has
  secrets.has = () => true // stub: avoid touching the real secrets file

  const keys = []
  for (let i = 1; i <= 12; i++) keys.push({ id: `cap:k${i}` })
  const provider = { id: "cap", keys }

  for (const k of keys) {
    health.markUsed(k.id)
    health.markSuccess(k.id, { latencyMs: 400 })
  }

  // round-robin strategy must also respect the cap
  const ordered = router.orderedKeys(provider, "round-robin")
  assert.ok(ordered.length === 3, `cap should allow up to 3 usable keys, got ${ordered.length}`)

  // fastest-first must also respect the cap
  const orderedFast = router.orderedKeys(provider, "fastest-first")
  assert.ok(orderedFast.length <= 3, `expected <= 3 keys, got ${orderedFast.length}`)

  secrets.has = origHas
  config.load = origLoad
  health.reset()
})
