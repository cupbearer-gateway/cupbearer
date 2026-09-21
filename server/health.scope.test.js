"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// The core regression test for model-scoped health: a failure on ONE model
// route (quota, no channel, model errors) must pull exactly that (key, model)
// pair — never the whole key for every model it serves.

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const config = require("./config")
const health = require("./health")
const { HEALTH_STATE_FILE } = require("./paths")

function stubSettings(overrides = {}) {
  const orig = config.load
  config.load = () => ({
    settings: { deadAfterFailures: 2, errorPullAfterFailures: 2, cooldownBaseSeconds: 5, cooldownMaxSeconds: 60, ...overrides },
  })
  return () => {
    config.load = orig
  }
}

test.beforeEach(() => {
  health.reset()
})

test.afterEach(() => {
  health.reset()
  health.flushStickySync() // cancel pending persist timer, write clean state
  try {
    fs.unlinkSync(HEALTH_STATE_FILE)
  } catch {}
})

test("a model-scoped quota failure pulls only that (key, model), not the key", () => {
  const restore = stubSettings()
  test.after(restore)

  // gpt-5.6-sol's budget pool at agentrouter is empty; the same key serves
  // deepseek-v4-flash and claude-opus-5 with the same credential.
  health.markFailure(
    "agentrouter:key-1",
    { reason: "budget_exhausted", keyState: "exhausted", scope: "leg", message: "Budget pool quota has been exhausted." },
    "gpt-5.6-sol",
  )

  const snap = health.snapshot("agentrouter:key-1")
  assert.strictEqual(snap.state, "healthy", "key-level state must stay healthy")
  assert.strictEqual(snap.usable, true, "key stays in rotation")
  assert.strictEqual(snap.sticky, true, "model pull is surfaced as sticky for the Reset button")

  // Other models unaffected.
  assert.strictEqual(health.isUsable("agentrouter:key-1", "deepseek-v4-flash"), true)
  assert.strictEqual(health.isUsable("agentrouter:key-1", "claude-opus-5"), true)

  // The failing model's route is pulled.
  assert.strictEqual(health.isUsable("agentrouter:key-1", "gpt-5.6-sol"), false)
  assert.deepStrictEqual(
    snap.modelStates.map((m) => m.model),
    ["gpt-5.6-sol"],
  )
  assert.strictEqual(snap.modelStates[0].state, "exhausted")
  assert.strictEqual(snap.modelStates[0].reason, "budget_exhausted")
})

test("auth failure is key-scoped: it pulls every model on the key", () => {
  const restore = stubSettings()
  test.after(restore)

  health.markFailure(
    "vyce:key-1",
    { reason: "invalid_key", keyState: "auth_failed", scope: "key", message: "Invalid token" },
    "deepseek-v4-flash",
  )

  assert.strictEqual(health.isUsable("vyce:key-1", "deepseek-v4-flash"), false)
  assert.strictEqual(health.isUsable("vyce:key-1", "gpt-5.6-luna-testing"), false)
  assert.deepStrictEqual(health.snapshot("vyce:key-1").modelStates, [])
})

test("a success on one model clears only that model's pull", () => {
  const restore = stubSettings()
  test.after(restore)

  health.markFailure(
    "p:k1",
    { reason: "credit_exhausted", keyState: "exhausted", scope: "leg", message: "out" },
    "model-a",
  )
  health.markFailure(
    "p:k1",
    { reason: "credit_exhausted", keyState: "exhausted", scope: "leg", message: "out" },
    "model-b",
  )
  assert.strictEqual(health.isUsable("p:k1", "model-a"), false)

  health.markSuccess("p:k1", {}, "model-a")

  assert.strictEqual(health.isUsable("p:k1", "model-a"), true)
  assert.strictEqual(health.isUsable("p:k1", "model-b"), false, "model-b's pull must survive")
})

test("a degraded streak marks the (key, model) dead without touching other models", () => {
  const restore = stubSettings({ errorPullAfterFailures: 2 })
  test.after(restore)

  const verdict = { reason: "upstream_error", keyState: "degraded", scope: "leg", message: "An internal error occurred." }
  health.markFailure("vyce:key-1", verdict, "deepseek-v4-flash")
  health.markFailure("vyce:key-1", verdict, "deepseek-v4-flash")

  assert.strictEqual(health.isUsable("vyce:key-1", "deepseek-v4-flash"), false)
  assert.strictEqual(health.isUsable("vyce:key-1", "gpt-5.6-luna-testing"), true, "other model on the same key stays up")
  const ms = health.snapshot("vyce:key-1").modelStates.find((m) => m.model === "deepseek-v4-flash")
  assert.strictEqual(ms.state, "dead")
})

test("no channel for a model marks it unavailable, not the key", () => {
  const restore = stubSettings()
  test.after(restore)

  health.markFailure(
    "seekai:key-1",
    { reason: "no_channel", keyState: "healthy", scope: "leg", message: "No available channel for model gpt-5.6-sol" },
    "gpt-5.6-sol",
  )

  assert.strictEqual(health.isUsable("seekai:key-1", "gpt-5.6-sol"), false)
  assert.strictEqual(health.isUsable("seekai:key-1", "claude-sonnet-5"), true)
  const ms = health.snapshot("seekai:key-1").modelStates.find((m) => m.model === "gpt-5.6-sol")
  assert.strictEqual(ms.state, "unavailable")
})

test("model-scoped sticky state persists and loads back", async () => {
  const restore = stubSettings()
  test.after(restore)

  health.markFailure(
    "p:k1",
    { reason: "budget_exhausted", keyState: "exhausted", scope: "leg", message: "pool empty" },
    "model-a",
  )
  health.flushStickySync()

  health.reset() // simulate restart
  const snap = health.snapshot("p:k1")
  assert.strictEqual(snap.state, "healthy")
  assert.strictEqual(health.isUsable("p:k1", "model-a"), false, "pulled route survives restart")
  assert.strictEqual(snap.modelStates[0].reason, "budget_exhausted")

  // A manual full clear releases every route.
  health.clear("p:k1")
  assert.strictEqual(health.isUsable("p:k1", "model-a"), true)
})
test("restart rotation returns cooling and degraded keys to rotation too", () => {
  const restore = stubSettings({ cooldownBaseSeconds: 60, cooldownMaxSeconds: 60 })
  test.after(restore)

  // One key rate limited (cooling, key-scoped), one key with a degraded streak
  // on a model route, one with an exhausted model route.
  health.markFailure("p:k1", { reason: "rate_limited", keyState: "cooling", scope: "key", message: "429" }, "model-a")
  health.markFailure("p:k2", { reason: "upstream_error", keyState: "degraded", scope: "leg", message: "500" }, "model-a")
  health.markFailure("p:k3", { reason: "budget_exhausted", keyState: "exhausted", scope: "leg", message: "empty" }, "model-b")
  assert.strictEqual(health.isUsable("p:k1", "model-a"), false)

  const cleared = health.clearSticky()
  assert.ok(cleared.keys >= 1, "the cooling key is counted")
  assert.ok(cleared.routes >= 2, "both pulled model routes are counted")
  assert.strictEqual(health.isUsable("p:k1", "model-a"), true, "cooling key is back in rotation")
  assert.strictEqual(health.isUsable("p:k2", "model-a"), true, "degraded streak reset")
  assert.strictEqual(health.isUsable("p:k3", "model-b"), true, "exhausted route cleared")
})
