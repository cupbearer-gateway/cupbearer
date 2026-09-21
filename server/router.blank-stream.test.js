"use strict"

// Isolation: never touch the live gateway's real config dir.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// A stream that ends cleanly having written nothing used to commit as a blank
// 200 event-stream. It is a pre-commit first_byte-style failure instead: the
// router fails over while it still can, and only when no leg remains does the
// client get the usual final error instead of silence.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const router = require("./router")

const SLOW = { id: "slow", label: "Slow", enabled: true, quirks: [], keys: [{ id: "slow:key-1" }] }
const FAST = { id: "fast", label: "Fast", enabled: true, quirks: [], keys: [{ id: "fast:key-1" }] }

const POOL = {
  id: "blank-stream-pool",
  name: "Blank Stream Pool",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "slow", model: "slow-model" },
    { providerId: "fast", model: "fast-model" },
  ],
}

const PAYLOAD = { stream: true, model: "blank-stream-pool", messages: [{ role: "user", content: "hi" }] }

// SSE a working leg would produce.
const SSE =
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, logprobs: null, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] })}\n\n` +
  "data: [DONE]\n\n"

function stubEnv(providers, pool) {
  const orig = {
    load: config.load,
    getProvider: config.getProvider,
    has: secrets.has,
    isUsable: health.isUsable,
    emit: events.emit,
    record: metrics.record,
    openStream: upstream.openStream,
  }
  config.load = () => ({ settings: {}, pools: [pool], providers })
  config.getProvider = (id) => providers.find((p) => p.id === id) || null
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
    write(b) {
      this.body = (this.body || "") + b
      return true
    },
    end(b) {
      if (b) this.body = (this.body || "") + b
    },
  }
}

// openStream stub: `empty` providers return a stream that closes cleanly with
// zero bytes; everyone else serves the normal SSE body.
function stubOpenStream(emptyIds) {
  upstream.openStream = async ({ provider, model }) => {
    if (emptyIds.includes(provider.id)) {
      return { ok: true, status: 200, res: new Response(""), latencyMs: 5, ctx: { provider, model, stream: true, tools: [] }, cleanup: () => {} }
    }
    return { ok: true, status: 200, res: new Response(SSE), latencyMs: 5, ctx: { provider, model, stream: true, tools: [] }, cleanup: () => {} }
  }
}

test("a clean empty stream is a pre-commit failure and the request fails over", async () => {
  const restore = stubEnv([SLOW, FAST], POOL)
  try {
    stubOpenStream(["slow"])
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "fast", "the router moved on instead of committing the blank stream")
    const row = outcome.attempts.find((a) => a.provider === "slow")
    assert.ok(row, "the empty leg left an attempt trace")
    assert.equal(row.reason, "first_byte_timeout")
    assert.match(String(res.body), /hello/, "the client sees the second leg's content")
  } finally {
    restore()
  }
})

test("with no leg left the request fails instead of committing a blank 200", async () => {
  const restore = stubEnv([SLOW], { ...POOL, legs: [{ providerId: "slow", model: "slow-model" }] })
  try {
    stubOpenStream(["slow"])
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.exhausted, true)
    assert.equal(outcome.committed, undefined, "the blank stream was never committed")
    assert.equal(res.headersSent, false, "no 200 event-stream reached the client")
    assert.equal(outcome.attempts[0].reason, "first_byte_timeout")
  } finally {
    restore()
  }
})
