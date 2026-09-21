"use strict"
// DOC: ../docs/operations.md → § Auto-revival & background probes · ../docs/architecture.md → § Module map → server/notify.js

// Background re-probe of pulled keys (exhausted / rejected / dead / cooling).
//
// Pulled keys are, by design, out of rotation until something proves they are
// back. Two mechanisms do the proving:
//
//   fast lane   the moment a key or (key, model) route is pulled, a re-probe
//               is scheduled ~20s out (settings.reviveSoonMs). If the drop was
//               a blip — an upstream flap, a short rate limit — the route is
//               back in rotation within half a minute instead of waiting for
//               the next sweep. A failed fast probe re-arms with doubling
//               backoff, up to the sweep interval where the slow lane takes over.
//   slow sweep  every settings.reviveIntervalMinutes, probeOnce() walks every
//               still-pulled key/route once (below).
//
// Both lanes test-call with the SPECIFIC model a pool uses the key for, and:
//
//   - probe succeeds  -> drop the key/route back into rotation, toast "is back"
//   - probe fails     -> leave it pulled and stay silent
//
// Read-only: a failed probe never calls health.markFailure, so probing cannot
// perturb real traffic or reset cooldowns.

const config = require("./config")
const events = require("./events")
const health = require("./health")
const notify = require("./notify")
const upstream = require("./upstream")
const quirks = require("./quirks")

let timer = null
let soonTimer = null
let kickoffTimer = null

// Health states that pull a key/route and are worth a quick re-probe.
// "degraded" is deliberately absent: a degraded key is still in rotation and
// every request already retries it.
const SOON_STATES = new Set(["cooling", "dead", "exhausted", "auth_failed", "unavailable"])

// Upper bound on concurrently scheduled fast probes; beyond it the slow sweep
// is the backstop. Targets are tiny (1-token calls) so this is about tidiness.
const MAX_SCHEDULED = 100

// targetKey -> { keyId, model, at, attempts }
const soon = new Map()
let onFailure = null

function sweepIntervalMs() {
  return (config.load().settings.reviveIntervalMinutes || 5) * 60000
}

function soonDelayMs() {
  // Floor is just a spin guard; config.validate keeps real settings >= 1000.
  return Math.max(250, Number(config.load().settings.reviveSoonMs) || 20000)
}

function resolveTarget(keyId) {
  const cfg = config.load()
  const provider = cfg.providers.find((p) => (p.keys || []).some((k) => k.id === keyId))
  const key = provider?.keys?.find((k) => k.id === keyId)
  if (!provider || !key || provider.enabled === false) return null
  return { provider, key }
}

// Schedule one quick re-probe of a pulled key or (key, model) route. The delay
// doubles with each failure (attempts carries across re-arms) up to the sweep
// interval, after which the slow sweep owns the target.
function schedule(keyId, model) {
  if (config.load().settings.reviveProbe === false) return
  if (!resolveTarget(keyId)) return

  const targetKey = model ? `${keyId}@${model}` : keyId
  const prev = soon.get(targetKey)
  if (soon.size >= MAX_SCHEDULED && !prev) return

  const base = soonDelayMs()
  const delay = Math.min(base * 2 ** (prev?.attempts || 0), sweepIntervalMs())
  const at = Math.min(prev?.at ?? Infinity, Date.now() + delay)
  soon.set(targetKey, { keyId, model: model || null, at, attempts: prev?.attempts || 0 })
  armSoon()
}

function armSoon() {
  if (soonTimer || !soon.size) return
  const earliest = Math.min(...[...soon.values()].map((t) => t.at))
  const wait = Math.max(250, earliest - Date.now())
  soonTimer = setTimeout(() => {
    soonTimer = null
    probeDue().catch(() => {})
  }, wait)
  if (soonTimer.unref) soonTimer.unref()
}

async function probeDue() {
  const now = Date.now()
  const due = []
  for (const [targetKey, t] of soon.entries()) {
    if (t.at <= now) {
      due.push([targetKey, t])
      soon.delete(targetKey)
    }
  }

  for (let i = 0; i < due.length; i++) {
    const [targetKey, t] = due[i]
    if (i > 0) await sleep(300) // stagger so a dozen dead keys don't fire at once
    const target = resolveTarget(t.keyId)
    const ok = target ? await probe(target.provider, target.key, t.model) : false
    if (ok) {
      announce(target.provider, target.key, t.model)
    } else if (target) {
      const base = soonDelayMs()
      const delay = Math.min(base * 2 ** (t.attempts + 1), sweepIntervalMs())
      if (delay < sweepIntervalMs()) {
        // Still inside fast-lane territory: re-arm. Past the sweep interval the
        // periodic sweep probes the target anyway, so drop it here.
        soon.set(targetKey, { ...t, attempts: t.attempts + 1, at: Date.now() + delay })
      }
    }
  }
  armSoon()
}

async function probe(provider, key, model) {
  const applied = quirks.compose(provider.quirks || [])
  const out = await upstream
    .callJson({
      provider,
      keyId: key.id,
      model,
      payload: { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      applied,
      timeoutMs: 30000,
    })
    .catch(() => ({ ok: false }))
  return Boolean(out.ok)
}

// A success proves the credential AND this model route are fine again. Key-level
// state clears only for key-level probes (which prove the credential); model-
// level probes clear only their own route — a restored route can never
// resurrect other routes that are still genuinely out.
function announce(provider, key, model) {
  if (model && !health.isUsable(key.id)) health.clearKeyLevel(key.id)
  health.clearModel(key.id, model)
  // Which key came back matters: after a "GonkaRouter key 2 is out of quota"
  // toast, "GonkaRouter is back" alone leaves you unsure whether that key or a
  // different one recovered.
  const which = model ? `${key.label || key.id} (${model})` : key.label || key.id
  notify.maybe({
    key: `revive:${provider.id}`,
    title: "Provider is back",
    message: `"${provider.label}" — ${which} answered again and is back in rotation.`,
  })
  events.emit("revive", { providerId: provider.id, keyId: key.id, model: model || null })
}

async function probeOnce() {
  const cfg = config.load()
  if (cfg.settings.reviveProbe === false) return

  // Two kinds of probe target:
  //   key-level sticky   (auth_failed / dead credential or connection) — one
  //                      probe per key with the first pool model that uses it.
  //   model-scoped pull  (exhausted / unavailable / dead for ONE model) — the
  //                      key itself may be in rotation; probe with the EXACT
  //                      model that failed, once per (key, model).
  const targets = new Map()
  const maxPerTick = cfg.settings.reviveMaxPerTick || 20

  for (const pool of cfg.pools) {
    for (const leg of pool.legs) {
      const provider = config.getProvider(leg.providerId)
      if (!provider || provider.enabled === false) continue
      for (const key of provider.keys || []) {
        const snap = health.snapshot(key.id)
        const keySticky = snap.sticky && !snap.usable
        const modelHit = snap.modelStates?.find((m) => m.model === leg.model)

        const keyTarget = keySticky && !targets.has(key.id) && targets.size < maxPerTick
        const modelTarget =
          modelHit &&
          (modelHit.sticky || modelHit.state === "unavailable") &&
          !targets.has(`${key.id}@${leg.model}`) &&
          targets.size < maxPerTick

        if (keyTarget) targets.set(key.id, { provider, key, model: leg.model })
        if (modelTarget) targets.set(`${key.id}@${leg.model}`, { provider, key, model: leg.model })
      }
    }
  }
  if (!targets.size) return

  const revived = new Map() // providerId -> provider
  for (const { provider, key, model } of targets.values()) {
    await sleep(300) // stagger so a dozen dead keys don't fire at once
    const ok = await probe(provider, key, model)
    if (ok) {
      // A success proves the credential AND this model route are fine again.
      // Key-level state clears only for key-level probes (which prove the
      // credential); model-level probes clear only their own route.
      if (targets.has(key.id)) health.clearKeyLevel(key.id)
      health.clearModel(key.id, model)
      const list = revived.get(provider.id) ?? { provider, keys: [] }
      list.keys.push(key.label || key.id)
      revived.set(provider.id, list)
    }
  }

  // One "is back" toast per provider. A dedicated cooldown key (not the
  // pool:provider failover key) so it can't be suppressed by a recent switch.
  for (const { provider, keys } of revived.values()) {
    const which = keys.length === 1 ? keys[0] : `${keys.length} keys`
    notify.maybe({
      key: `revive:${provider.id}`,
      title: "Provider is back",
      message: `"${provider.label}" — ${which} back in rotation. Cupbearer will use it again.`,
    })
    events.emit("revive", { providerId: provider.id, keys })
  }
}

// test hook: inspect the fast-lane queue
function scheduled() {
  return [...soon.entries()].map(([targetKey, t]) => ({ targetKey, ...t }))
}

function start() {
  stop() // idempotent: never stack timers or listeners
  const minutes = config.load().settings.reviveIntervalMinutes || 5

  onFailure = ({ keyId, model, state }) => {
    // Key-level pulls come through directly; model-scoped ones arrive with a
    // healthy key-level state, so read the pulled route off the snapshot.
    if (SOON_STATES.has(state)) return schedule(keyId, model)
    if (model) {
      const hit = health.snapshot(keyId).modelStates?.find((m) => m.model === model)
      if (hit && SOON_STATES.has(hit.state)) schedule(keyId, model)
    }
  }
  events.on("failure", onFailure)

  // First pass shortly after boot, then on the interval.
  kickoffTimer = setTimeout(() => {
    kickoffTimer = null
    probeOnce().catch(() => {})
  }, 20000)
  if (kickoffTimer.unref) kickoffTimer.unref()

  timer = setInterval(() => {
    probeOnce().catch(() => {})
  }, minutes * 60000)
  if (timer.unref) timer.unref()
}

function stop() {
  if (timer) clearInterval(timer)
  if (soonTimer) clearTimeout(soonTimer)
  if (kickoffTimer) clearTimeout(kickoffTimer)
  timer = null
  soonTimer = null
  kickoffTimer = null
  if (onFailure) {
    events.off("failure", onFailure)
    onFailure = null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = { start, stop, probeOnce, schedule, scheduled }
