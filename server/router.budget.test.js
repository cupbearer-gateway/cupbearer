"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid
// DOC: ../docs/architecture.md → § Time budgets

// Cupbearer used to have no clock. One attempt could wait 300s for a first response
// and 60s for any chunk, the relay applied that same 60s to the *first* read as
// well as later ones, and nothing bounded the chain — deepseek-v4-flash is 4 legs
// / 16 keys, so the worst case was 16 x 300s. From the client's seat that is not
// a failover system, it is a hang. These tests pin the three budgets that replaced
// it: a tight pre-commit wait for the first byte, a generous post-commit wait for
// the next one, and a hard ceiling on the whole request.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const health = require("./health")
const secrets = require("./secrets")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const router = require("./router")
const { relay } = require("./relay")
const quirks = require("./quirks")

// ---------------------------------------------------------------- relay budgets

function fakeRes() {
  return {
    chunks: [],
    headersSent: false,
    writeHead(code) {
      this.headersSent = true
      this.code = code
    },
    write(s) {
      this.chunks.push(s)
      return true
    },
    end(b) {
      this.body = b
    },
    get text() {
      return this.chunks.join("")
    },
  }
}

// A stream that never yields: read() hangs forever, so only a timeout ends it.
//
// The hang promise holds no handle, and the relay's timeout is deliberately
// unref'd — on Node 22 that empties the event loop and the runner cancels the
// pending test ("event loop has already resolved"). A ref'd keep-alive timer
// holds the loop until the relay's finally calls cancel(), which releases it.
function silentBody() {
  return {
    body: {
      getReader() {
        const keepAlive = setTimeout(() => {}, 30_000)
        return {
          read: () => new Promise(() => {}),
          cancel: async () => {
            clearTimeout(keepAlive)
          },
        }
      },
    },
  }
}

// Yields one usable chunk, then hangs. Exercises the *inter-chunk* budget.
function oneChunkThenSilence() {
  const encoder = new TextEncoder()
  const line = `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content: "hi" }, logprobs: null, finish_reason: null }],
  })}\n`
  return {
    body: {
      getReader() {
        let sent = false
        // Keep-alive for the hang below — see silentBody().
        const keepAlive = setTimeout(() => {}, 30_000)
        return {
          read: () =>
            sent
              ? new Promise(() => {})
              : ((sent = true), Promise.resolve({ done: false, value: encoder.encode(line) })),
          cancel: async () => {
            clearTimeout(keepAlive)
          },
        }
      },
    },
  }
}

const CTX = { provider: { id: "p" }, model: "m", stream: true, tools: [] }

test("a stream that never sends a byte is cut at firstChunkTimeoutMs, not chunkTimeoutMs", async () => {
  const t0 = Date.now()
  const out = await relay({
    upstream: silentBody(),
    res: fakeRes(),
    applied: quirks.compose([]),
    ctx: CTX,
    chunkTimeoutMs: 60000,
    firstChunkTimeoutMs: 150,
  })
  const elapsed = Date.now() - t0

  assert.ok(elapsed < 3000, `should give up on the tight budget, waited ${elapsed}ms`)
  assert.equal(out.errored, true)
  assert.equal(out.wrote, false, "nothing flushed -> the router can still fail over")
  assert.equal(out.sawUpstreamBytes, false, "distinguishes silence from a mid-response drop")
  assert.match(out.errorMessage, /no first byte from upstream/)
})

test("once a stream is flowing the longer inter-chunk budget applies", async () => {
  const t0 = Date.now()
  const out = await relay({
    upstream: oneChunkThenSilence(),
    res: fakeRes(),
    applied: quirks.compose([]),
    ctx: CTX,
    chunkTimeoutMs: 200,
    // Deliberately tiny: it must NOT be reused once bytes have arrived.
    firstChunkTimeoutMs: 1,
  })
  const elapsed = Date.now() - t0

  assert.ok(elapsed >= 150, `should have waited out the inter-chunk budget, only ${elapsed}ms`)
  assert.equal(out.errored, true)
  assert.equal(out.sawUpstreamBytes, true)
  assert.match(out.errorMessage, /no data from upstream/)
})

// --------------------------------------------------------------- router budgets

const SLOW = { id: "slow", label: "Slow", enabled: true, quirks: [], keys: [{ id: "slow:key-1" }] }
const FAST = { id: "fast", label: "Fast", enabled: true, quirks: [], keys: [{ id: "fast:key-1" }] }

const POOL = {
  id: "budget-pool",
  name: "Budget Pool",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "slow", model: "slow-model" },
    { providerId: "fast", model: "fast-model" },
  ],
}

const PAYLOAD = { stream: false, model: "budget-pool", messages: [{ role: "user", content: "hi" }] }
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

const PROVIDERS = { slow: SLOW, fast: FAST }

function stubEnv(settings) {
  config.load = () => ({ settings, pools: [POOL], providers: [SLOW, FAST] })
  // buildPlan resolves legs through config.getProvider, which calls config.js'
  // *internal* load(), so stubbing load() alone leaves every leg provider_missing.
  config.getProvider = (id) => PROVIDERS[id] || null
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
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

test("each attempt is handed only what is left of the request budget", async () => {
  stubEnv({ requestBudgetMs: 1200, attemptTimeoutMs: 90000 })
  const slices = []
  upstream.callJson = async ({ timeoutMs }) => {
    slices.push(timeoutMs)
    await new Promise((r) => setTimeout(r, 250))
    return { ok: false, status: 500, body: { error: { message: "upstream boom" } }, latencyMs: 250 }
  }

  await router.dispatch({ pool: POOL, payload: PAYLOAD, res: fakeRes() })

  assert.ok(slices.length >= 2, `expected a failover, got ${slices.length} attempt(s)`)
  assert.ok(
    slices[0] <= 1200,
    `an attempt must never be allowed to outlive the request budget, got ${slices[0]}`,
  )
  assert.ok(slices[1] < slices[0], "the second attempt gets the smaller remainder")
})

test("when the budget runs out the request stops instead of starting another attempt", async () => {
  stubEnv({ requestBudgetMs: 300, attemptTimeoutMs: 90000 })
  let calls = 0
  upstream.callJson = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 320))
    return { ok: false, status: 500, body: { error: { message: "upstream boom" } }, latencyMs: 320 }
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })

  assert.equal(calls, 1, "the budget was gone after the first attempt — do not burn the next key")
  assert.equal(outcome.requestError.reason, "request_budget_exceeded")
  assert.equal(outcome.status, 504)
  assert.equal(res.headersSent, false)
})

test("a healthy pool is unaffected by the budget", async () => {
  stubEnv({ requestBudgetMs: 180000, attemptTimeoutMs: 90000 })
  upstream.callJson = async () => OK

  const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res: fakeRes() })

  assert.equal(outcome.committed, true)
  assert.equal(outcome.providerId, "slow", "top leg, first try, no budget interference")
})

// ------------------------------------------------- committed streams keep their own chunk budget
//
// A slow FAILED leg used to leave the next leg's flowing stream an inter-chunk
// timeout of whatever was left of the request budget (5s minSliceMs at worst),
// killing reasoning models that legitimately pause. The budget bounds
// time-to-commit (firstChunkSlice); an already-flowing stream gets the
// provider's own chunkTimeoutMs, un-clamped.

const STREAM_SLOW = { id: "slow", label: "Slow", enabled: true, quirks: [], keys: [{ id: "slow:key-1" }] }
const STREAM_FAST = {
  id: "fast",
  label: "Fast",
  enabled: true,
  quirks: [],
  chunkTimeoutMs: 3000,
  firstChunkTimeoutMs: 30000,
  keys: [{ id: "fast:key-1" }],
}
const STREAM_POOL = {
  id: "budget-stream-pool",
  name: "Budget Stream Pool",
  keyStrategy: "round-robin",
  legs: [
    { providerId: "slow", model: "slow-model" },
    { providerId: "fast", model: "fast-model" },
  ],
}
const STREAM_PAYLOAD = { stream: true, model: "budget-stream-pool", messages: [{ role: "user", content: "hi" }] }

const SETTINGS = { requestBudgetMs: 1000, attemptTimeoutMs: 90000, legRetries: 0 }

function stubStreamEnv() {
  stubEnv(SETTINGS)
  config.load = () => ({ settings: SETTINGS, pools: [STREAM_POOL], providers: [STREAM_SLOW, STREAM_FAST] })
  config.getProvider = (id) => ({ slow: STREAM_SLOW, fast: STREAM_FAST })[id] || null
}

test("a flowing stream keeps the provider's own chunk timeout, not the budget remainder", async () => {
  stubStreamEnv()
  const realOpenStream = upstream.openStream
  try {
    upstream.openStream = async ({ provider }) => {
      if (provider.id === "slow") {
        await new Promise((r) => setTimeout(r, 200))
        return { ok: false, status: 500, body: { error: { message: "down" } }, latencyMs: 200, abort: () => {} }
      }
      return {
        ok: true,
        status: 200,
        res: oneChunkThenSilence(),
        latencyMs: 5,
        ctx: { provider, model: "fast-model", stream: true, tools: [] },
        cleanup: () => {},
      }
    }
    const t0 = Date.now()
    const outcome = await router.dispatch({ pool: STREAM_POOL, payload: STREAM_PAYLOAD, res: fakeRes() })
    const elapsed = Date.now() - t0

    assert.equal(outcome.committed, true, "the fast leg committed before the stream stalled")
    // The provider's own inter-chunk budget is 3000ms; the budget remainder was
    // well under half that. Pre-fix the silence was cut at the remainder.
    assert.ok(elapsed >= 1800, `a flowing stream must not be cut at the budget remainder, ended after ${elapsed}ms`)
    assert.ok(elapsed < 5000, `the provider chunk timeout should bound it, took ${elapsed}ms`)
  } finally {
    upstream.openStream = realOpenStream
  }
})

test("the first-byte wait is still clamped to the budget remainder", async () => {
  stubStreamEnv()
  const realOpenStream = upstream.openStream
  try {
    upstream.openStream = async ({ provider }) => {
      if (provider.id === "slow") {
        await new Promise((r) => setTimeout(r, 200))
        return { ok: false, status: 500, body: { error: { message: "down" } }, latencyMs: 200, abort: () => {} }
      }
      return {
        ok: true,
        status: 200,
        res: silentBody(),
        latencyMs: 5,
        ctx: { provider, model: "fast-model", stream: true, tools: [] },
        cleanup: () => {},
      }
    }
    const t0 = Date.now()
    const outcome = await router.dispatch({ pool: STREAM_POOL, payload: STREAM_PAYLOAD, res: fakeRes() })
    const elapsed = Date.now() - t0

    // Pre-commit is abandonable, so it stays bounded by the request budget:
    // ~the remainder, never the provider's own 30s first-chunk setting.
    assert.ok(elapsed < 2500, `the first-byte wait must stay budget-clamped, took ${elapsed}ms`)
    assert.equal(outcome.exhausted, true)
    assert.equal(outcome.attempts.find((a) => a.reason === "first_byte_timeout")?.provider, "fast")
  } finally {
    upstream.openStream = realOpenStream
  }
})
