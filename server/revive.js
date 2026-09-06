"use strict"
// DOC: ../docs/operations.md → § Auto-revival · ../docs/architecture.md → § Module map → server/revive.js

// Background re-probe of sticky keys (exhausted / rejected / dead).
//
// Sticky keys are pulled from rotation and, by design, only come back on an
// explicit dashboard action. But if the user tops up or fixes a key on the
// provider's own site, Cupbearer would never notice — the pool would keep falling
// through to the next provider forever. This module periodically test-calls each
// sticky key with the SPECIFIC model a pool uses it for (the dashboard Test
// button uses the provider's first model, which may differ), and:
//
//   - probe succeeds  -> drop the key back into rotation, toast "is back"
//   - probe fails     -> leave it sticky and stay silent
//
// Read-only: a failed probe never calls health.markFailure, so probing cannot
// perturb real traffic or reset cooldowns.

const config = require("./config")
const health = require("./health")
const notify = require("./notify")
const upstream = require("./upstream")
const quirks = require("./quirks")

let timer = null

async function probeOnce() {
  const cfg = config.load()
  if (cfg.settings.reviveProbe === false) return

  // One probe per key, using the first pool model that references it.
  const targets = new Map()
  const maxPerTick = cfg.settings.reviveMaxPerTick || 20

  for (const pool of cfg.pools) {
    for (const leg of pool.legs) {
      const provider = config.getProvider(leg.providerId)
      if (!provider || provider.enabled === false) continue
      for (const key of provider.keys || []) {
        if (!health.snapshot(key.id).sticky) continue
        if (!targets.has(key.id) && targets.size < maxPerTick) {
          targets.set(key.id, { pool, provider, key, model: leg.model })
        }
      }
    }
  }
  if (!targets.size) return

  const revived = new Map() // providerId -> provider
  for (const { provider, key, model } of targets.values()) {
    await sleep(300) // stagger so a dozen dead keys don't fire at once
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

    if (out.ok) {
      // Which key came back matters: after a "GonkaRouter key 2 is out of
      // quota" toast, "GonkaRouter is back" alone leaves you unsure whether
      // that key or a different one recovered.
      health.clear(key.id)
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
  }
}

function start() {
  stop() // idempotent: never stack timers when settings change or start is re-called
  const minutes = config.load().settings.reviveIntervalMinutes || 5
  // First pass shortly after boot, then on the interval.
  const kickoff = setTimeout(() => {
    probeOnce().catch(() => {})
  }, 20000)
  if (kickoff.unref) kickoff.unref()

  timer = setInterval(() => {
    probeOnce().catch(() => {})
  }, minutes * 60000)
  if (timer.unref) timer.unref()
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = { start, stop, probeOnce }
