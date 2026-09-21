"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid
// DOC: ../docs/architecture.md → § Module map → server/revive.js

// revive.js re-probes sticky keys in the background so a fixed or topped-up
// provider comes back on its own. These tests pin the decision logic with
// stubbed modules — nothing is called over the network during the run.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const health = require("./health")
const notify = require("./notify")
const upstream = require("./upstream")
const quirks = require("./quirks")
const revive = require("./revive")

const KEY = "tabitoken:key-1"

let cleared = []
let probes = []
let toasts = []

const TABITOKEN = { id: "tabitoken", label: "Tabitoken", enabled: true, quirks: [], keys: [{ id: KEY, label: "Tabitoken key 1" }] }
const JUSTWOKER = { id: "justwoker", label: "JustWoker", enabled: true, quirks: [], keys: [{ id: "justwoker:key-1" }] }

function fakeConfig(settings = {}) {
  const origLoad = config.load
  const origGetProvider = config.getProvider
  const providers = [TABITOKEN, JUSTWOKER]
  config.load = () => ({
    settings: { reviveProbe: true, reviveIntervalMinutes: 5, ...settings },
    pools: [
      { id: "opus-5", name: "Opus 5", legs: [{ providerId: "tabitoken", model: "claude-opus-5" }] },
    ],
    providers,
  })
  // revive resolves providers through getProvider; stub it so the test does not
  // depend on whatever happens to sit in the machine's live config.
  config.getProvider = (id) => providers.find((p) => p.id === id) || null
  return () => {
    config.load = origLoad
    config.getProvider = origGetProvider
  }
}

// snapshot is sticky only for the tabitoken key.
function fakeHealth() {
  const origSnap = health.snapshot
  const origClear = health.clear
  const origClearKeyLevel = health.clearKeyLevel
  const origClearModel = health.clearModel
  // No `usable`/`modelStates` fields: a key-level sticky snapshot is enough, and
  // the absence of modelStates must not trip the model-scoped probe path.
  health.snapshot = (id) => ({ state: id === KEY ? "auth_failed" : "healthy", sticky: id === KEY })
  health.clear = (id) => {
    cleared.push(id)
    return { state: "healthy" }
  }
  health.clearKeyLevel = (id) => {
    cleared.push(id)
    return { state: "healthy" }
  }
  health.clearModel = (id) => {
    cleared.push(id)
  }
  return () => {
    health.snapshot = origSnap
    health.clear = origClear
    health.clearKeyLevel = origClearKeyLevel
    health.clearModel = origClearModel
  }
}

function fakeOutbound(ok) {
  const origCall = upstream.callJson
  const origCompose = quirks.compose
  upstream.callJson = async (opts) => {
    probes.push({ keyId: opts.keyId, model: opts.model })
    return ok ? { ok: true, latencyMs: 42 } : { ok: false, status: 403 }
  }
  quirks.compose = () => ({})
  return () => {
    upstream.callJson = origCall
    quirks.compose = origCompose
  }
}

function fakeNotify() {
  const orig = notify.maybe
  notify.maybe = (o) => {
    toasts.push(o)
    return true
  }
  return () => {
    notify.maybe = orig
  }
}

test.beforeEach(() => {
  cleared = []
  probes = []
  toasts = []
})

test("revives a sticky key and toasts when the probe succeeds", async () => {
  const restores = [fakeConfig(), fakeHealth(), fakeOutbound(true), fakeNotify()]
  test.after(() => restores.forEach((r) => r()))

  await revive.probeOnce()

  // A successful probe proves the credential (key-level clear) and the probed
  // model route (model-scoped clear) — two distinct clears, both legitimate.
  assert.deepStrictEqual(cleared, [KEY, KEY])
  assert.strictEqual(toasts.length, 1)
  assert.strictEqual(toasts[0].title, "Provider is back")
  assert.match(toasts[0].message, /Tabitoken/)
  // Names the key that recovered: after a "key 2 is out of quota" toast,
  // "Tabitoken is back" alone would not say which key came back.
  assert.match(toasts[0].message, /Tabitoken key 1/)
  // Keyed separately from the failover cooldown so it always shows.
  assert.strictEqual(toasts[0].key, `revive:${KEY.slice(0, 9)}`)
})

test("probes with the model the pool uses, not the provider's first model", async () => {
  const restores = [fakeConfig(), fakeHealth(), fakeOutbound(false), fakeNotify()]
  test.after(() => restores.forEach((r) => r()))

  await revive.probeOnce()

  assert.strictEqual(probes.length, 1)
  assert.strictEqual(probes[0].keyId, KEY)
  assert.strictEqual(probes[0].model, "claude-opus-5")
})

test("a failed probe leaves the key sticky and stays silent", async () => {
  const restores = [fakeConfig(), fakeHealth(), fakeOutbound(false), fakeNotify()]
  test.after(() => restores.forEach((r) => r()))

  await revive.probeOnce()

  assert.deepStrictEqual(cleared, [])
  assert.deepStrictEqual(toasts, [])
})

test("respects reviveProbe disabled", async () => {
  const restores = [fakeConfig({ reviveProbe: false }), fakeHealth(), fakeOutbound(true), fakeNotify()]
  test.after(() => restores.forEach((r) => r()))

  await revive.probeOnce()

  assert.deepStrictEqual(probes, [])
  assert.deepStrictEqual(cleared, [])
  assert.deepStrictEqual(toasts, [])
})

test("does not probe healthy keys", async () => {
  const restores = [fakeConfig(), fakeHealth(), fakeOutbound(true), fakeNotify()]
  test.after(() => restores.forEach((r) => r()))

  await revive.probeOnce()

  // justwoker's key is healthy; only the sticky tabitoken key is probed.
  assert.deepStrictEqual(probes.map((p) => p.keyId), [KEY])
})

test("revives a model-scoped pull with the exact model and keeps the key in rotation", async () => {
  // Real health state: the key itself is healthy, only its claude-opus-5 route
  // is exhausted (budget pool for that model empty). The probe must use that
  // exact model, clear only that route, and leave the key-level state alone.
  health.reset()
  health.markFailure(KEY, { reason: "budget_exhausted", keyState: "exhausted", scope: "leg", message: "budget pool empty" }, "claude-opus-5")
  const restores = [fakeConfig(), fakeOutbound(true), fakeNotify()]
  test.after(() => {
    restores.forEach((r) => r())
    health.reset()
    // Cancel any pending persist timer and drop the transient test entry from
    // the real health-state file, so a fake model record never leaks to disk.
    health.flushStickySync()
  })

  await revive.probeOnce()

  assert.deepStrictEqual(probes.map((p) => p.keyId), [KEY])
  assert.strictEqual(probes[0].model, "claude-opus-5")
  const snap = health.snapshot(KEY)
  assert.strictEqual(snap.state, "healthy", "key-level state must survive a model-scoped recovery")
  assert.deepStrictEqual(snap.modelStates, [], "the revived model route must be back in rotation")
})

// ---------------------------------------------------------------------------
// Fast lane: a pulled key/route is re-probed ~20s after the drop, not at the
// next sweep. These tests shrink reviveSoonMs so the wait is milliseconds.
// ---------------------------------------------------------------------------

test("fast lane: schedule() probes the exact model after the delay and restores it", async () => {
  health.reset()
  health.markFailure(KEY, { reason: "rate_limited", keyState: "cooling", scope: "key", message: "429" }, "claude-opus-5")
  assert.strictEqual(health.isUsable(KEY), false, "precondition: the key is cooling")
  const restores = [
    fakeConfig({ reviveSoonMs: 40, cooldownBaseSeconds: 20, cooldownMaxSeconds: 600 }),
    fakeOutbound(true),
    fakeNotify(),
  ]
  test.after(() => {
    restores.forEach((r) => r())
    health.reset()
    health.flushStickySync()
  })

  revive.schedule(KEY, "claude-opus-5")
  assert.strictEqual(revive.scheduled().length, 1, "one fast probe pending")
  await new Promise((r) => setTimeout(r, 400))

  assert.strictEqual(probes.length, 1, "probed once, at the fast delay")
  assert.strictEqual(probes[0].model, "claude-opus-5")
  assert.strictEqual(health.isUsable(KEY), true, "cooldown cleared — back in rotation")
  assert.strictEqual(toasts.length, 1)
  assert.strictEqual(toasts[0].title, "Provider is back")
})

test("fast lane: a failure event on a pulled route schedules the re-probe", async () => {
  health.reset()
  health.markFailure(
    KEY,
    { reason: "budget_exhausted", keyState: "exhausted", scope: "leg", message: "pool empty" },
    "claude-opus-5",
  )
  const restores = [fakeConfig({ reviveSoonMs: 40, cooldownBaseSeconds: 20, cooldownMaxSeconds: 600 }), fakeOutbound(true), fakeNotify()]
  test.after(() => {
    restores.forEach((r) => r())
    revive.stop()
    health.reset()
    health.flushStickySync()
  })

  revive.start()
  const events = require("./events")
  // The router emits key-level state; a model-scoped pull leaves it healthy,
  // so the fast lane must read the pulled route off the snapshot itself.
  events.emit("failure", { poolId: "opus-5", providerId: "tabitoken", keyId: KEY, model: "claude-opus-5", reason: "budget_exhausted", state: "healthy" })
  assert.strictEqual(revive.scheduled().length, 1, "model-scoped pull was picked up")
  await new Promise((r) => setTimeout(r, 400))

  assert.strictEqual(probes.length, 1)
  assert.strictEqual(probes[0].model, "claude-opus-5")
  assert.deepStrictEqual(health.snapshot(KEY).modelStates, [], "the pulled route is back")
})

test("fast lane: a failed probe backs off instead of looping", async () => {
  health.reset()
  const restores = [fakeConfig({ reviveSoonMs: 30 }), fakeOutbound(false), fakeNotify()]
  test.after(() => {
    restores.forEach((r) => r())
    health.reset()
    health.flushStickySync()
  })

  revive.schedule(KEY, "claude-opus-5")
  await new Promise((r) => setTimeout(r, 350))
  const n = probes.length
  assert.ok(n >= 1, "at least one probe ran")
  assert.ok(n <= 4, "backoff keeps the probe count tiny, not a spin loop")
  assert.strictEqual(revive.scheduled().length, 1, "still armed for the next round")
})
