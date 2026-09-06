"use strict"
// DOC: ../docs/api.md → § OpenAI surface

// What HTTP status a dead pool reports, and why it is not always 503.
//
// The client decides whether to retry from the status alone — it never sees the
// per-leg breakdown in the body. Measured against ZCode: a 503 is classified
// `server_error` / retryable, so ZCode re-sends the entire turn (up to 11
// attempts) even when Cupbearer has just established that no leg can serve it. That
// turns one dead pool into a dozen pointless passes and a much later error.
//
// So the surface distinguishes:
//   503  at least one leg failed for something that may pass — rate limit,
//        upstream 5xx, timeout, a dropped stream. Retrying is reasonable.
//   502  every attempt failed for a reason a retry cannot change, or nothing was
//        even attempted (no keys, providers parked, credentials rejected). This is
//        a configuration problem; the client should surface it, not loop.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const router = require("./router")
const surface = require("./openai-surface")

const POOL = { id: "p", name: "P", keyStrategy: "round-robin", legs: [{ providerId: "a", model: "m" }] }

function fakeReqRes(payload) {
  const req = {
    on(ev, fn) {
      if (ev === "data") fn(Buffer.from(JSON.stringify(payload)))
      if (ev === "end") fn()
      return req
    },
  }
  const res = {
    headersSent: false,
    writeHead(code) {
      this.headersSent = true
      this.code = code
    },
    end(b) {
      this.body = b
    },
  }
  return { req, res }
}

const orig = { load: config.load, getPool: config.getPool, dispatch: router.dispatch }

test.afterEach(() => {
  config.load = orig.load
  config.getPool = orig.getPool
  router.dispatch = orig.dispatch
})

function stub(attempts) {
  config.load = () => ({ settings: {}, pools: [POOL], providers: [] })
  config.getPool = (id) => (id === "p" ? POOL : null)
  router.dispatch = async () => ({ exhausted: true, attempts })
}

test("a pool whose legs hit transient errors reports 503 so the client may retry", async () => {
  stub([{ provider: "a", model: "m", keyId: "a:1", reason: "rate_limited", message: "slow down" }])
  const { req, res } = fakeReqRes({ model: "p", messages: [] })
  await surface.chatCompletions(req, res)
  assert.equal(res.code, 503)
})

test("a pool with nothing usable reports 502, not a retryable 503", async () => {
  // Every leg skipped before any attempt: retrying cannot change this.
  stub([{ provider: "a", model: "m", skipped: "all_keys_unusable" }])
  const { req, res } = fakeReqRes({ model: "p", messages: [] })
  await surface.chatCompletions(req, res)
  assert.equal(res.code, 502)
  assert.match(String(res.body), /all_keys_unusable/)
})

test("rejected credentials report 502 — a retry sends the same rejected key", async () => {
  stub([{ provider: "a", model: "m", keyId: "a:1", reason: "invalid_key", message: "Invalid token" }])
  const { req, res } = fakeReqRes({ model: "p", messages: [] })
  await surface.chatCompletions(req, res)
  assert.equal(res.code, 502)
})

test("a mixed pool still reports 503 if any leg's failure could pass", async () => {
  stub([
    { provider: "a", model: "m", keyId: "a:1", reason: "invalid_key", message: "Invalid token" },
    { provider: "b", model: "m", keyId: "b:1", reason: "upstream_error", message: "502 from upstream" },
  ])
  const { req, res } = fakeReqRes({ model: "p", messages: [] })
  await surface.chatCompletions(req, res)
  assert.equal(res.code, 503)
})
