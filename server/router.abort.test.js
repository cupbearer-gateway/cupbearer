"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// A client hang-up is not the upstream's fault. The abort propagates into the
// attempt and reads like a transport failure, but marking it degraded healthy
// keys (3 cancels pulled one dead). Budget timeouts are different: they abort
// upstream's own controller, not this signal, so they still count.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const router = require("./router")

const P = { id: "p", label: "P", enabled: true, quirks: [], keys: [{ id: "p:key-1" }, { id: "p:key-2" }] }
const POOL = { id: "abort-pool", name: "Abort Pool", keyStrategy: "round-robin", legs: [{ providerId: "p", model: "m" }] }
const PAYLOAD = { stream: false, model: "abort-pool", messages: [{ role: "user", content: "hi" }] }

function abortError() {
  const e = new Error("This operation was aborted")
  e.name = "AbortError"
  return e
}

function stubEnv() {
  const orig = {
    load: config.load,
    getProvider: config.getProvider,
    has: secrets.has,
    get: secrets.get,
    isUsable: health.isUsable,
    emit: events.emit,
    record: metrics.record,
    callJson: upstream.callJson,
    openStream: upstream.openStream,
  }
  config.load = () => ({ settings: {}, pools: [POOL], providers: [P] })
  config.getProvider = (id) => (id === "p" ? P : null)
  secrets.has = () => true
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
    upstream.callJson = orig.callJson
    upstream.openStream = orig.openStream
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

test("a client abort after a failed attempt does not degrade the key", async () => {
  const restore = stubEnv()
  try {
    const ctrl = new AbortController()
    upstream.callJson = async () => {
      ctrl.abort() // the client hangs up during the attempt
      return { ok: false, status: 0, latencyMs: 5, error: abortError() }
    }
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res: fakeRes(), signal: ctrl.signal })
    assert.equal(outcome.aborted, true)
    assert.equal(health.snapshot("p:key-1").state, "healthy", "a cancel is not the upstream's fault")
  } finally {
    restore()
  }
})

test("a client abort before stream headers does not degrade the key either", async () => {
  const restore = stubEnv()
  try {
    const ctrl = new AbortController()
    upstream.openStream = async () => {
      ctrl.abort()
      return { ok: false, status: 0, latencyMs: 5, error: abortError(), abort: () => {} }
    }
    const outcome = await router.dispatch({
      pool: POOL,
      payload: { ...PAYLOAD, stream: true },
      res: fakeRes(),
      signal: ctrl.signal,
    })
    assert.equal(outcome.aborted, true)
    assert.equal(health.snapshot("p:key-1").state, "healthy", "the streaming path follows the same rule")
  } finally {
    restore()
  }
})

test("an upstream timeout with no client abort still counts against the key", async () => {
  const restore = stubEnv()
  try {
    // Same transport error shape, but nobody cancelled the client.
    upstream.callJson = async () => ({ ok: false, status: 0, latencyMs: 5, error: abortError() })
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res: fakeRes() })
    assert.equal(outcome.exhausted, true)
    assert.equal(health.snapshot("p:key-1").state, "degraded", "budget timeouts abort upstream's own controller — they still mark")
  } finally {
    restore()
  }
})
