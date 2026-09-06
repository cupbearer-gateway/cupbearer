"use strict"
// DOC: ../docs/operations.md → § Desktop notifications

// Which failover events are worth interrupting the user for.
//
// The policy these tests pin, decided from how the pools are actually built:
//
//   key -> key, transient   SILENT. Multiple keys per provider exist so rate
//                           limits and timeouts are absorbed invisibly. The key
//                           will be back; a toast turns normal operation into
//                           noise.
//   key -> key, key lost    TOAST. A revoked or quota-exhausted key is a
//                           permanently thinner pool and nothing else would
//                           tell you.
//   leg -> leg              TOAST. A whole provider dropped out of a pool.
//   pool down               TOAST. Requests are failing.
//
// The router decides WHAT happened; notify.js decides whether to shout. These
// tests stub the event bus, so nothing spawns powershell.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const health = require("./health")
const secrets = require("./secrets")
const events = require("./events")
const router = require("./router")

const PROVIDER = {
  id: "gonkarouter",
  label: "GonkaRouter",
  enabled: true,
  quirks: [],
  keys: [
    { id: "gonkarouter:key-1", label: "GonkaRouter key 1" },
    { id: "gonkarouter:key-2", label: "GonkaRouter key 2" },
    { id: "gonkarouter:key-3", label: "GonkaRouter key 3" },
  ],
}

const POOL = {
  id: "deepseek-gonka",
  name: "Deepseek GONKA",
  legs: [{ providerId: "gonkarouter", model: "deepseek-ai/DeepSeek-V4-Flash-0731" }],
}

let toasts = []
let restore = []

test.beforeEach(() => {
  toasts = []
  restore = []

  const origLoad = config.load
  config.load = () => ({ settings: {}, pools: [POOL], providers: [PROVIDER] })
  restore.push(() => {
    config.load = origLoad
  })

  const origHas = secrets.has
  secrets.has = () => true
  restore.push(() => {
    secrets.has = origHas
  })

  const origEmit = events.emit
  events.emit = (type, payload) => {
    if (type === "provider_failover") toasts.push(payload)
  }
  restore.push(() => {
    events.emit = origEmit
  })
})

test.afterEach(() => {
  for (const fn of restore.reverse()) fn()
  health.reset()
})

// Only two of three keys usable, so the "still working" count is checkable.
function withUsable(n) {
  const orig = health.isUsable
  health.isUsable = (id) => PROVIDER.keys.findIndex((k) => k.id === id) < n
  restore.push(() => {
    health.isUsable = orig
  })
}

function keySwitch(keyState, reason) {
  router._internals.notifyKeySwitch(POOL, PROVIDER, "gonkarouter:key-2", { keyState, reason })
}

// ------------------------------------------------------------------- transient

test("a rate-limited key rotates silently", () => {
  withUsable(2)
  keySwitch("cooling", "rate_limited")
  assert.deepEqual(toasts, [], "rotation across keys on one provider is not news")
})

test("a timed-out or degraded key rotates silently", () => {
  withUsable(2)
  keySwitch("degraded", "upstream_timeout")
  keySwitch("degraded", "connection_failed")
  keySwitch("degraded", "upstream_error")
  assert.deepEqual(toasts, [])
})

// ------------------------------------------------------------------ key lost

test("a key with no quota left is announced with what is left", () => {
  withUsable(2)
  keySwitch("exhausted", "credit_exhausted")
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "Key out of action")
  assert.match(toasts[0].message, /GonkaRouter key 2/)
  assert.match(toasts[0].message, /out of quota/)
  // Actionable: how much redundancy remains.
  assert.match(toasts[0].message, /2 keys still working/)
})

test("a revoked key is announced too", () => {
  withUsable(2)
  keySwitch("auth_failed", "invalid_key")
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /rejected key/)
})

test("singular wording when one key is left", () => {
  withUsable(1)
  keySwitch("exhausted", "credit_exhausted")
  assert.match(toasts[0].message, /1 key still working/)
  assert.ok(!/1 keys/.test(toasts[0].message))
})

test("losing the last key says the pool now leans on other providers", () => {
  withUsable(0)
  keySwitch("exhausted", "credit_exhausted")
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /No keys left/)
})

test("the cooldown identity is per key, so two pools do not double-toast", () => {
  withUsable(2)
  keySwitch("exhausted", "credit_exhausted")
  // Same key noticed while serving a different pool.
  router._internals.notifyKeySwitch(
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", legs: POOL.legs },
    PROVIDER,
    "gonkarouter:key-2",
    { keyState: "exhausted", reason: "credit_exhausted" },
  )
  assert.equal(toasts.length, 2, "the router emits both")
  // notify.js dedupes on this key, so only the first reaches the Action Center.
  assert.equal(toasts[0].key, toasts[1].key)
  assert.match(toasts[0].key, /^keyloss:gonkarouter:gonkarouter:key-2$/)
})

// ------------------------------------------------------------ provider / pool

test("a provider failover names both providers", () => {
  const twoLeg = {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    legs: [
      { providerId: "gonkarouter", model: "m1" },
      { providerId: "vyce", model: "m2" },
    ],
  }
  const origLoad = config.load
  const origGetProvider = config.getProvider
  const providers = [PROVIDER, { id: "vyce", label: "Vyce AI", enabled: true, quirks: [], keys: [{ id: "vyce:key-1" }] }]
  config.load = () => ({
    settings: {},
    pools: [twoLeg],
    providers,
  })
  config.getProvider = (id) => providers.find((p) => p.id === id) || null
  restore.push(() => {
    config.load = origLoad
    config.getProvider = origGetProvider
  })

  const plan = [
    { leg: twoLeg.legs[0], provider: PROVIDER, keys: ["gonkarouter:key-1"] },
    { leg: twoLeg.legs[1], provider: { id: "vyce" }, keys: ["vyce:key-1"] },
  ]
  router._internals.notifyProviderFailover(twoLeg, plan[0], plan, 0, { reason: "credit_exhausted" })

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "Switched provider")
  assert.match(toasts[0].message, /GonkaRouter/)
  assert.match(toasts[0].message, /Vyce AI/)
})

test("no next leg means the pool is reported down", () => {
  const plan = [{ leg: POOL.legs[0], provider: PROVIDER, keys: ["gonkarouter:key-1"] }]
  router._internals.notifyProviderFailover(POOL, plan[0], plan, 0, { reason: "credit_exhausted" })
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "Pool has no working provider")
  assert.match(toasts[0].message, /Deepseek GONKA/)
})
