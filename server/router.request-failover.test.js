"use strict"
// DOC: ../docs/architecture.md → § Request lifecycle

// A request-scoped error (retry: false) used to abort the whole request on the
// first leg: classify() says "our payload is the problem, failover is pointless."
// That holds for verdicts that are genuinely universal — content_filtered, and a
// quirk's truncated_tool_call (a deterministic output cap) — but not for two that
// only look universal:
//
//   bad_request       the bare-400 fallback, reached when no message rule matched,
//                     i.e. the classifier is guessing. vyce 400s a request
//                     gonkarouter returns 200 for.
//   context_too_long  context windows are per-deployment. Probed directly: vyce
//                     caps deepseek-v4-flash at 128k while gonkarouter and
//                     agentrouter accept a 130k prompt on the same model.
//
// These tests pin all three behaviours — the two provider-specific verdicts take
// one more leg, a universal one still stops dead, and a single-provider pool fails
// fast either way.

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
const POOL_ONE = { ...POOL_TWO, legs: POOL_TWO.legs.slice(0, 1) }

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

const BAD_REQUEST = { ok: false, status: 400, body: { error: { message: "bad request" } }, latencyMs: 5 }
// Same status, but a message rule matches. Provider-specific: this leg's
// deployment is capped lower than the next leg's.
const CONTEXT_TOO_LONG = {
  ok: false,
  status: 400,
  body: { error: { message: "This model's maximum context length is 65536 tokens" } },
  latencyMs: 5,
}
// Genuinely universal: no other provider would answer this either.
const CONTENT_FILTERED = {
  ok: false,
  status: 400,
  body: { error: { message: "Blocked by the content filter" } },
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

// The old tests implicitly resolved providers from the machine's live config;
// these are hermetic: both the config and the provider lookup are stubbed.
function stubConfig() {
  config.load = () => ({ settings: {}, pools: [POOL_TWO, POOL_ONE], providers: [VYCE, GONKA] })
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

test("a 400 on one leg fails over to the next provider in a multi-provider pool", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? BAD_REQUEST : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.equal(outcome.committed, true, "the request should be served by the next provider")
  assert.equal(outcome.providerId, "gonkarouter", "it failed over off the 400 leg")
  assert.deepEqual(tried, ["vyce", "gonkarouter"])
  assert.equal(res.code, 200)
})

test("a context-window rejection tries the next provider, whose deployment may be bigger", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  const tried = []
  upstream.callJson = async ({ provider }) => {
    tried.push(provider.id)
    return provider.id === "vyce" ? CONTEXT_TOO_LONG : OK
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.equal(outcome.committed, true, "gonkarouter serves the same model with a bigger window")
  assert.equal(outcome.providerId, "gonkarouter")
  assert.deepEqual(tried, ["vyce", "gonkarouter"])
})

test("a universally-fatal rejection still stops dead on a multi-provider pool", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  let calls = 0
  upstream.callJson = async () => {
    calls++
    return CONTENT_FILTERED
  }

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.equal(calls, 1, "a content filter blocks this prompt everywhere — do not burn another leg")
  assert.ok(outcome.requestError)
  assert.equal(outcome.requestError.reason, "content_filtered")
  assert.equal(res.headersSent, false)
})

test("a 400 on a single-provider pool still fails fast with the 400", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  upstream.callJson = async () => BAD_REQUEST

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_ONE, payload: PAYLOAD, res })

  assert.ok(outcome.requestError, "single leg: no failover, surface the error")
  assert.equal(outcome.status, 400)
  assert.equal(res.headersSent, false, "nothing was committed to the client")
})

test("a request-scoped error on every leg surfaces the last 400 without hanging", async () => {
  stubConfig()
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = () => {}
  metrics.record = () => {}
  upstream.callJson = async () => BAD_REQUEST

  const res = fakeRes()
  const outcome = await router.dispatch({ pool: POOL_TWO, payload: PAYLOAD, res })

  assert.ok(outcome.requestError, "last leg also rejected -> surface the 400 (no failover left)")
  assert.equal(outcome.status, 400)
  assert.equal(res.headersSent, false, "nothing was committed to the client")
})
