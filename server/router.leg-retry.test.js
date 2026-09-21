"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// Same-leg retry: a transient upstream error (5xx / 408) gets one immediate
// retry on the same provider before the request pays the next leg's latency.
// Pins the retry budget (settings.legRetries: 0 disables, N allows N) and that
// a leg-scoped verdict which is NOT transient (no_channel) never burns one.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const health = require("./health")
const secrets = require("./secrets")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const router = require("./router")

const VYCE = { id: "vyce", label: "Vyce AI", enabled: true, quirks: [], keys: [{ id: "vyce:key-1", label: "Vyce key 1" }] }
const GONKA = { id: "gonkarouter", label: "GonkaRouter", enabled: true, quirks: [], keys: [{ id: "gonkarouter:key-1", label: "Gonka key 1" }] }

const POOL_TWO = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "vyce", model: "deepseek-v4-flash" },
    { providerId: "gonkarouter", model: "deepseek-ai/DeepSeek-V4-Flash-0731" },
  ],
}

const PAYLOAD = { stream: false, model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }

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

// vyce's observed internal error, served with a 500.
const UPSTREAM_ERROR = {
  ok: false,
  status: 500,
  body: { error: { message: "An internal error occurred." } },
  latencyMs: 5,
}
// Leg-scoped but not transient: no other key on this provider would do better.
const NO_CHANNEL = {
  ok: false,
  status: 503,
  body: { error: { message: "No available channel for model deepseek-v4-flash under group default" } },
  latencyMs: 5,
}
const OK = {
  ok: true,
  status: 200,
  body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  latencyMs: 5,
}

const orig = {
  load: config.load,
  getProvider: config.getProvider,
  has: secrets.has,
  isUsable: health.isUsable,
  emit: events.emit,
  record: metrics.record,
  callJson: upstream.callJson,
}

function stubConfig(settings = {}) {
  config.load = () => ({ settings, pools: [POOL_TWO], providers: [VYCE, GONKA] })
  config.getProvider = (id) => [VYCE, GONKA].find((p) => p.id === id) || null
}

test.afterEach(() => {
  config.load = orig.load
  config.getProvider = orig.getProvider
  secrets.has = orig.has
  health.isUsable = orig.isUsable
  events.emit = orig.emit
  metrics.record = orig.record
  upstream.callJson = orig.callJson
  health.reset()
  router.resetCursors()
})

test("a transient upstream error retries the same leg once before failing over", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? UPSTREAM_ERROR : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.deepEqual(tried, ["vyce", "vyce", "gonkarouter"], "one same-leg retry absorbs the flap, then failover")
  assert.equal(outcome.committed, true)
  assert.equal(outcome.providerId, "gonkarouter")
})

test("legRetries: 0 restores fail-first behavior", async () => {
  stubConfig({ legRetries: 0 })
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? UPSTREAM_ERROR : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.deepEqual(tried, ["vyce", "gonkarouter"])
  assert.equal(outcome.committed, true)
})

test("legRetries: 2 retries the same leg twice", async () => {
  stubConfig({ legRetries: 2 })
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? UPSTREAM_ERROR : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.deepEqual(tried, ["vyce", "vyce", "vyce", "gonkarouter"])
  assert.equal(outcome.committed, true)
})

test("a non-transient leg failure (no channel) does not burn same-leg retries", async () => {
  stubConfig({ legRetries: 2 })
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? NO_CHANNEL : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.deepEqual(tried, ["vyce", "gonkarouter"], "no key on this leg can do better — skip immediately")
  assert.equal(outcome.committed, true)
})

test("the retry is per leg: the next leg still gets its own budget", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return UPSTREAM_ERROR
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.deepEqual(tried, ["vyce", "vyce", "gonkarouter", "gonkarouter"])
  assert.ok(outcome.exhausted, "every leg exhausted its retry budget -> pool down")
})
