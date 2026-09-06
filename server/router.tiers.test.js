"use strict"

// Tiered routing: the profiler's requirement reorders legs so the cheapest
// sufficient leg serves the request, capability-insufficient legs fall back,
// and pools without tiers route in declared order exactly as before.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const router = require("./router")

const FLAGSHIP = { id: "flagship", label: "Flagship", enabled: true, quirks: [], keys: [{ id: "flagship:key-1" }] }
const LIGHT = { id: "light", label: "Light", enabled: true, quirks: [], keys: [{ id: "light:key-1" }] }

const POOL = {
  id: "smart",
  name: "Smart",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "flagship", model: "big", tier: 1, capabilities: ["tools"] },
    { providerId: "light", model: "small", tier: 3 },
  ],
}

const PROVIDERS = [FLAGSHIP, LIGHT]

// ------------------------------------------------------------------ orderLegs

test("a light request tries the cheap leg first", () => {
  const ordered = router.orderLegs(POOL, { requiredTier: 3, capabilities: [] })
  assert.deepEqual(ordered.map((o) => o.leg.providerId), ["light", "flagship"])
  assert.equal(ordered[0].downgrade, false)
})

test("an agentic request tries the flagship first and marks the light leg a downgrade", () => {
  const ordered = router.orderLegs(POOL, { requiredTier: 1, capabilities: ["tools"] })
  assert.deepEqual(ordered.map((o) => o.leg.providerId), ["flagship", "light"])
  assert.equal(ordered[0].downgrade, false)
  assert.equal(ordered[1].downgrade, true, "serving an agentic task from the light leg is a downgrade")
})

test("capability-insufficient legs fall behind sufficient ones regardless of tier", () => {
  const visionPool = {
    id: "vision",
    legs: [
      { providerId: "light", model: "small", tier: 3 },
      { providerId: "flagship", model: "big", tier: 1, capabilities: ["vision"] },
    ],
  }
  const ordered = router.orderLegs(visionPool, { requiredTier: 3, capabilities: ["vision"] })
  assert.deepEqual(ordered.map((o) => o.leg.providerId), ["flagship", "light"])
})

test("a pool without tiers keeps its declared order for any requirement", () => {
  const plain = { id: "plain", legs: [{ providerId: "a", model: "m" }, { providerId: "b", model: "m" }] }
  for (const tier of [1, 2, 3]) {
    const ordered = router.orderLegs(plain, { requiredTier: tier, capabilities: [] })
    assert.deepEqual(ordered.map((o) => o.leg.providerId), ["a", "b"])
    assert.equal(ordered.every((o) => !o.downgrade), tier !== 1, `tier ${tier}: undeclared legs are tier ${router._internals.DEFAULT_LEG_TIER}, a downgrade only for flagship requests`)
  }
})

test("no requirement means declared order (direct provider/model escape hatch)", () => {
  const ordered = router.orderLegs(POOL, null)
  assert.deepEqual(ordered.map((o) => o.leg.providerId), ["flagship", "light"])
})

// ------------------------------------------------------------------- dispatch

const OK = {
  ok: true,
  status: 200,
  body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  latencyMs: 5,
}

function stubAll() {
  const orig = {
    load: config.load,
    getProvider: config.getProvider,
    has: secrets.has,
    isUsable: health.isUsable,
    emit: events.emit,
    record: metrics.record,
    callJson: upstream.callJson,
  }
  config.load = () => ({ settings: {}, pools: [POOL], providers: PROVIDERS })
  config.getProvider = (id) => PROVIDERS.find((p) => p.id === id) || null
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  return () => {
    Object.assign(config, { load: orig.load, getProvider: orig.getProvider })
    secrets.has = orig.has
    health.isUsable = orig.isUsable
    events.emit = orig.emit
    metrics.record = orig.record
    upstream.callJson = orig.callJson
    health.reset()
    router.resetCursors()
  }
}

function fakeRes() {
  return {
    headersSent: false,
    writeHead(code) {
      this.headersSent = true
      this.code = code
    },
    end(b) {
      this.body = b
    },
  }
}

test("dispatch serves a short chat from the cheap leg", async () => {
  const restore = stubAll()
  try {
    const tried = []
    upstream.callJson = async ({ provider }) => {
      tried.push(provider.id)
      return OK
    }
    const outcome = await router.dispatch({
      pool: POOL,
      payload: { model: "smart", messages: [{ role: "user", content: "hi" }] },
      res: fakeRes(),
    })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "light")
    assert.deepEqual(tried, ["light"])
  } finally {
    restore()
  }
})

test("dispatch serves an agentic request from the flagship leg", async () => {
  const restore = stubAll()
  try {
    const tried = []
    upstream.callJson = async ({ provider }) => {
      tried.push(provider.id)
      return OK
    }
    const tools = Array.from({ length: 5 }, (_, i) => ({ type: "function", function: { name: `t${i}` } }))
    const outcome = await router.dispatch({
      pool: POOL,
      payload: { model: "smart", messages: [{ role: "user", content: "hi" }], tools },
      res: fakeRes(),
    })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "flagship")
    assert.deepEqual(tried, ["flagship"])
  } finally {
    restore()
  }
})
