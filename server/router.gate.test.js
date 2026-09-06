"use strict"

// The quality gate, end to end through dispatch: a downgrade is blocked when
// its response is junk (and the request moves on), served when it holds, and
// only logged in shadow mode. Every decision lands in the evidence store.

const os = require("os")
const fs = require("fs")
const path = require("path")
process.env.CUPBEARER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-gate-test-"))

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const events = require("./events")
const metrics = require("./metrics")
const upstream = require("./upstream")
const store = require("./store")
const router = require("./router")

const STRONG = { id: "strong", label: "Strong", enabled: true, quirks: [], keys: [{ id: "strong:key-1" }] }
const LIGHT = { id: "light", label: "Light", enabled: true, quirks: [], keys: [{ id: "light:key-1" }] }

// The agentic payload requires tier 1, so the tier-3 leg is a downgrade — the
// only kind of attempt the gate is allowed to block.
const POOL = {
  id: "gated",
  name: "Gated",
  keyStrategy: "round-robin",
  qualityGate: { mode: "gate", threshold: 0.8 },
  legs: [
    { providerId: "strong", model: "big", tier: 1 },
    { providerId: "light", model: "small", tier: 3 },
  ],
}

const TOOLS = Array.from({ length: 5 }, (_, i) => ({ type: "function", function: { name: `t${i}` } }))
const PAYLOAD = { model: "gated", stream: false, messages: [{ role: "user", content: "hi" }], tools: TOOLS }

const LOOP = `The quick brown fox jumps over the lazy dog again and again.\n`.repeat(6)
const CLEAN = "Here is a complete, competent answer to your question."

function ok(text, model = "small") {
  return {
    ok: true,
    status: 200,
    body: { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    latencyMs: 5,
  }
}

function stubAll({ strong = null, light = null } = {}, { stream = false } = {}) {
  const orig = {
    load: config.load,
    getProvider: config.getProvider,
    has: secrets.has,
    isUsable: health.isUsable,
    emit: events.emit,
    record: metrics.record,
    callJson: upstream.callJson,
    openStream: upstream.openStream,
  }
  const gateEvents = []
  config.load = () => ({ settings: {}, pools: [POOL], providers: [STRONG, LIGHT] })
  config.getProvider = (id) => [STRONG, LIGHT].find((p) => p.id === id) || null
  secrets.has = () => true
  health.isUsable = () => true
  events.emit = (type, payload) => {
    if (type === "gate") gateEvents.push(payload)
  }
  metrics.record = () => {}
  const behavior = (provider) => (provider.id === "strong" ? strong : light)
  if (stream) {
    upstream.openStream = async ({ provider, model }) => {
      const text = behavior(provider)
      if (text === "FAIL") return { ok: false, status: 500, body: { error: { message: "down" } }, latencyMs: 5, abort: () => {} }
      const sse =
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, logprobs: null, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] })}\n\n` +
        `data: [DONE]\n\n`
      return { ok: true, status: 200, res: new Response(sse), latencyMs: 5, ctx: { provider, model, stream: true, tools: PAYLOAD.tools }, cleanup: () => {} }
    }
  } else {
    upstream.callJson = async ({ provider }) => {
      const text = behavior(provider)
      if (text === "FAIL") return { ok: false, status: 500, body: { error: { message: "down" } }, latencyMs: 5 }
      return ok(text)
    }
  }
  return () => {
    Object.assign(config, { load: orig.load, getProvider: orig.getProvider })
    secrets.has = orig.has
    health.isUsable = orig.isUsable
    events.emit = orig.emit
    metrics.record = orig.record
    upstream.callJson = orig.callJson
    upstream.openStream = orig.openStream
    health.reset()
    router.resetCursors()
  }
  function unused() {}
  void unused
}

// Decision rows must not leak between tests: close the connection AND remove
// the database file (reset alone only closes it).
test.afterEach(() => {
  store.reset()
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(store.DB_FILE + suffix, { force: true })
    } catch {}
  }
})

function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      this.headersSent = true
      this.code = code
    },
    write(b) {
      this.body = (this.body || "") + b
      return true
    },
    end(b) {
      if (b) this.body = (this.body || "") + b
      this.writableEnded = true
    },
  }
}

async function decisions() {
  store.flush()
  return store.recentDecisions(20)
}

test("gate mode blocks a junk downgrade and the request moves on / fails honestly", async () => {
  const restore = stubAll({ strong: "FAIL", light: LOOP })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.committed, undefined, "nothing was committed: the only reachable leg failed the gate")
    assert.equal(res.headersSent, false, "no bytes reached the client")
    const rows = await decisions()
    const gateRow = rows.find((r) => r.mode === "gate")
    assert.ok(gateRow, "the failed gate decision is recorded as evidence")
    assert.equal(gateRow.passed, false)
    assert.equal(gateRow.downgrade, true)
    assert.equal(gateRow.providerId, "light")
    const attempt = outcome.attempts.find((a) => a.reason === "quality_gate_failed")
    assert.ok(attempt, "the attempts trace names the quality failure")
  } finally {
    restore()
  }
})

test("gate mode serves a downgrade whose quality holds", async () => {
  const restore = stubAll({ strong: "FAIL", light: CLEAN })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "light")
    assert.equal(res.code, 200)
    assert.match(String(res.body), /Here is a complete, competent answer/)
    const rows = await decisions()
    const gateRow = rows.find((r) => r.mode === "gate")
    assert.equal(gateRow.passed, true)
    assert.equal(gateRow.score, 1)
  } finally {
    restore()
  }
})

test("gate mode never blocks a first-choice (non-downgrade) leg", async () => {
  const restore = stubAll({ strong: CLEAN, light: LOOP })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "strong", "the flagship leg is served without evaluation")
    const rows = await decisions()
    assert.equal(rows.filter((r) => r.mode === "gate").length, 0, "no gate decisions: nothing was a downgrade")
  } finally {
    restore()
  }
})

test("shadow mode serves everything and only logs", async () => {
  const shadowPool = { ...POOL, qualityGate: { mode: "shadow", threshold: 0.8 } }
  const restore = stubAll({ strong: "FAIL", light: LOOP })
  config.load = () => ({ settings: {}, pools: [shadowPool], providers: [STRONG, LIGHT] })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: shadowPool, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true, "shadow never blocks")
    assert.equal(outcome.providerId, "light", "the junk response was served anyway")
    // Shadow evaluation is detached; give it a beat, then check the evidence.
    await new Promise((r) => setTimeout(r, 50))
    const rows = await decisions()
    const shadowRow = rows.find((r) => r.mode === "shadow")
    assert.ok(shadowRow, "the shadow decision is recorded")
    assert.equal(shadowRow.passed, false)
  } finally {
    restore()
  }
})

test("gate mode off is pure availability routing", async () => {
  const offPool = { ...POOL, qualityGate: { mode: "off" } }
  const restore = stubAll({ strong: "FAIL", light: LOOP })
  config.load = () => ({ settings: {}, pools: [offPool], providers: [STRONG, LIGHT] })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: offPool, payload: PAYLOAD, res })
    assert.equal(outcome.committed, true, "junk served without complaint when the gate is off")
    assert.equal(outcome.providerId, "light")
  } finally {
    restore()
  }
})

test("streaming downgrades are buffered, gated, and committed only on pass", async () => {
  const restore = stubAll({ strong: "FAIL", light: CLEAN }, { stream: true })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: { ...PAYLOAD, stream: true }, res })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.providerId, "light")
    assert.equal(res.headersSent, true)
    assert.match(String(res.body), /Here is a complete, competent answer/)
    assert.match(String(res.body), /data: \[DONE\]/)
    const rows = await decisions()
    assert.equal(rows.find((r) => r.mode === "gate").passed, true)
  } finally {
    restore()
  }
})

test("streaming downgrades that fail the gate never reach the client", async () => {
  const restore = stubAll({ strong: "FAIL", light: LOOP }, { stream: true })
  try {
    const res = fakeRes()
    const outcome = await router.dispatch({ pool: POOL, payload: { ...PAYLOAD, stream: true }, res })
    assert.equal(outcome.committed, undefined)
    assert.equal(res.headersSent, false, "the buffered junk was withheld")
    assert.equal(res.body, undefined)
    const attempt = outcome.attempts.find((a) => a.reason === "quality_gate_failed")
    assert.ok(attempt)
  } finally {
    restore()
  }
})
