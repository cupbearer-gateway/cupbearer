"use strict"

// Isolation: never touch the live gateway's real config dir.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// A user-authored quirk that throws while shaping the outbound call must read
// as a classified bad_quirks leg failure — the router skips the leg and tries
// the next provider — not escape dispatch as a bare unclassified 500. This runs
// the REAL upstream.callJson (only fetch is stubbed), so it pins the wiring:
// quirk throw → classified failure → failover.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const events = require("./events")
const metrics = require("./metrics")
const waf = require("./quirks/waf-headers")
const router = require("./router")

const BOOM = { id: "boom", label: "Boom", enabled: true, baseURL: "https://boom.test/v1", quirks: ["waf-headers"], keys: [{ id: "boom:key-1" }] }
const OK = { id: "ok", label: "OK", enabled: true, baseURL: "https://ok.test/v1", quirks: [], keys: [{ id: "ok:key-1" }] }
const POOL = {
  id: "quirk-pool",
  name: "Quirk Pool",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "boom", model: "m" },
    { providerId: "ok", model: "m" },
  ],
}
const PAYLOAD = { stream: false, model: "quirk-pool", messages: [{ role: "user", content: "hi" }] }

function stubEnv() {
  const orig = {
    load: config.load,
    getProvider: config.getProvider,
    has: secrets.has,
    get: secrets.get,
    isUsable: health.isUsable,
    emit: events.emit,
    record: metrics.record,
  }
  config.load = () => ({ settings: {}, pools: [POOL], providers: [BOOM, OK] })
  config.getProvider = (id) => [BOOM, OK].find((p) => p.id === id) || null
  secrets.has = () => true
  secrets.get = () => "sk-test"
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  return () => {
    Object.assign(config, { load: orig.load, getProvider: orig.getProvider })
    secrets.has = orig.has
    secrets.get = orig.get
    health.isUsable = orig.isUsable
    events.emit = orig.emit
    metrics.record = orig.record
  }
}

test.afterEach(() => {
  health.reset()
  router.resetCursors()
})

function fakeRes() {
  return {
    headersSent: false,
    writeHead(code) {
      this.headersSent = true
      this.code = code
    },
    write() {
      return true
    },
    end() {},
  }
}

test("a throwing quirk skips the leg and the request fails over to the next provider", async () => {
  const restore = stubEnv()
  const origHeaders = waf.transformHeaders
  const realFetch = global.fetch
  waf.transformHeaders = () => {
    throw new Error("exploding transformHeaders")
  }
  global.fetch = async (url) => {
    assert.match(String(url), /ok\.test/, "the quirk-broken leg never reaches the network")
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: {} }),
    }
  }
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "ok", "the next leg was tried and served")
    const row = outcome.attempts.find((a) => a.provider === "boom")
    assert.ok(row, "the broken leg left an attempt trace")
    assert.equal(row.reason, "bad_quirks")
  } finally {
    waf.transformHeaders = origHeaders
    global.fetch = realFetch
    restore()
  }
})
