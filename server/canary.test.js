"use strict"
// DOC: ../docs/architecture.md → § Module map → server/canary.js

// canary.js probes keys that still look healthy, so a provider that died quietly is
// found before the next real request finds it. These tests pin the two properties
// that decide whether it is useful or just noise — coverage spread and what a probe
// failure is allowed to do to a key — with every module stubbed. No network.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const health = require("./health")
const upstream = require("./upstream")
const quirks = require("./quirks")
const canary = require("./canary")

// Six keys on one provider, all healthy, referenced by three pools. The same key
// appears on several legs on purpose: that is the shape that used to make the canary
// probe key-1 forever.
function fakeConfig(settings = {}) {
  const keys = Array.from({ length: 6 }, (_, i) => ({ id: `p:key-${i + 1}` }))
  const orig = config.load
  const origGet = config.getProvider
  const provider = { id: "p", label: "P", enabled: true, quirks: [], keys }
  config.load = () => ({
    settings: { canaryEnabled: true, canaryIntervalMinutes: 15, ...settings },
    pools: [
      { id: "a", legs: [{ providerId: "p", model: "m1" }] },
      { id: "b", legs: [{ providerId: "p", model: "m1" }] },
      { id: "c", legs: [{ providerId: "p", model: "m2" }] },
    ],
    providers: [provider],
  })
  config.getProvider = (id) => (id === "p" ? provider : null)
  return () => {
    config.load = orig
    config.getProvider = origGet
  }
}

function fakeHealth() {
  const origSnap = health.snapshot
  const origOk = health.markSuccess
  const origFail = health.markFailure
  const failures = []
  health.snapshot = () => ({ state: "healthy", sticky: false, usable: true })
  health.markSuccess = () => {}
  health.markFailure = (id, verdict) => failures.push({ id, reason: verdict.reason })
  return {
    failures,
    restore: () => {
      health.snapshot = origSnap
      health.markSuccess = origOk
      health.markFailure = origFail
    },
  }
}

function fakeOutbound(reply) {
  const origCall = upstream.callJson
  const origCompose = quirks.compose
  const probed = []
  upstream.callJson = async (opts) => {
    probed.push(opts.keyId)
    return reply
  }
  quirks.compose = () => ({})
  return {
    probed,
    restore: () => {
      upstream.callJson = origCall
      quirks.compose = origCompose
    },
  }
}

test("a key shared by several pools is probed once, not once per pool", async () => {
  const restoreConfig = fakeConfig()
  const h = fakeHealth()
  const out = fakeOutbound({ ok: true, latencyMs: 10 })
  try {
    await canary.probeOnce()
    assert.strictEqual(out.probed.length, new Set(out.probed).size, "no key probed twice in one tick")
  } finally {
    out.restore()
    h.restore()
    restoreConfig()
  }
})

test("successive ticks move on to keys they have not checked yet", async () => {
  const restoreConfig = fakeConfig()
  const h = fakeHealth()
  const out = fakeOutbound({ ok: true, latencyMs: 10 })
  try {
    await canary.probeOnce()
    const first = [...out.probed]
    out.probed.length = 0
    await canary.probeOnce()
    const second = [...out.probed]
    assert.ok(first.length > 0 && second.length > 0)
    assert.deepStrictEqual(
      first.filter((id) => second.includes(id)),
      [],
      "the second tick must not re-probe the first tick's keys while others are unchecked",
    )
  } finally {
    out.restore()
    h.restore()
    restoreConfig()
  }
})

test("a probe that is too long for the model does not cost the key its place", async () => {
  const restoreConfig = fakeConfig()
  const h = fakeHealth()
  const out = fakeOutbound({
    ok: false,
    status: 400,
    body: { error: { message: "This model's maximum context length is 128000 tokens" } },
  })
  try {
    await canary.probeOnce()
    assert.deepStrictEqual(h.failures, [], "context_too_long describes the probe, not the key")
  } finally {
    out.restore()
    h.restore()
    restoreConfig()
  }
})

test("a real refusal is recorded against the key", async () => {
  const restoreConfig = fakeConfig()
  const h = fakeHealth()
  const out = fakeOutbound({ ok: false, status: 401, body: { error: { message: "Invalid token" } } })
  try {
    await canary.probeOnce()
    assert.ok(h.failures.length > 0, "an invalid key must be marked")
    assert.strictEqual(h.failures[0].reason, "invalid_key")
  } finally {
    out.restore()
    h.restore()
    restoreConfig()
  }
})

test("the scheduled loop stays off when disabled, but check-now still runs", async () => {
  const restoreConfig = fakeConfig({ canaryEnabled: false })
  const h = fakeHealth()
  const out = fakeOutbound({ ok: true, latencyMs: 10 })
  try {
    await canary.probeOnce()
    assert.strictEqual(out.probed.length, 0, "disabled means the timer path does nothing")
    await canary.probeOnce({ force: true })
    assert.ok(out.probed.length > 0, "an explicit check must run regardless")
  } finally {
    out.restore()
    h.restore()
    restoreConfig()
  }
})
