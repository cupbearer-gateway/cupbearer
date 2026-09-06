"use strict"
// DOC: ../docs/architecture.md → § Module map → server/health.js

// Key health state machine.
//
// State is derived from real traffic, not background probing — accurate and
// free. States live in memory (they are observations, not configuration) and are
// rebuilt naturally as requests flow.
//
// States:
//   healthy      in rotation
//   cooling      rate-limited; back automatically after a backoff window
//   degraded     failing but maybe transient; stays in rotation
//   exhausted    upstream says this key has nothing left; pulled
//   auth_failed  key rejected; pulled
//   dead         N consecutive total non-responses; pulled
//
// exhausted / auth_failed / dead are sticky by design: silently retrying a
// revoked key on every request wastes latency on a guaranteed failure. Clearing
// them is an explicit act (dashboard Test button, or editing the key).
//
// Deliberately NOT tracked: currency balances. Cupbearer used to poll the gateways'
// billing endpoints and show "$3 left", but resellers report those numbers in
// their own units against their own caps, so the figure was wrong often enough to
// be worse than nothing. `exhausted` is inferred from what the upstream actually
// says when it refuses a call, which is the only part that ever drove routing.

const fs = require("fs")
const path = require("path")
const config = require("./config")
const { HEALTH_STATE_FILE } = require("./paths")

const STICKY = new Set(["exhausted", "auth_failed", "dead"])
const TTL_MS = {
  exhausted: 12 * 3600 * 1000,
  dead: 1 * 3600 * 1000,
  auth_failed: 24 * 3600 * 1000,
}

// keyId -> record
const states = new Map()
let saveTimer = null
let loadedPersisted = false

function flushStickySync() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const persisted = {}
    const now = Date.now()
    for (const [keyId, rec] of states.entries()) {
      const s = effectiveState(rec)
      if (STICKY.has(s)) {
        persisted[keyId] = {
          state: s,
          reason: rec.reason,
          message: rec.message,
          markedAt: rec.lastErrorAt || now,
        }
      }
    }
    fs.mkdirSync(path.dirname(HEALTH_STATE_FILE), { recursive: true })
    const tmp = `${HEALTH_STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2) + "\n", "utf8")
    fs.renameSync(tmp, HEALTH_STATE_FILE)
  } catch {}
}

function saveStickyState() {
  if (saveTimer) return
  saveTimer = setTimeout(flushStickySync, 100)
}

function loadStickyState() {
  if (loadedPersisted) return
  loadedPersisted = true
  try {
    if (!fs.existsSync(HEALTH_STATE_FILE)) return
    const raw = fs.readFileSync(HEALTH_STATE_FILE, "utf8")
    const persisted = JSON.parse(raw)
    const now = Date.now()

    for (const [keyId, item] of Object.entries(persisted)) {
      if (!STICKY.has(item.state)) continue
      const maxAge = TTL_MS[item.state] || (12 * 3600 * 1000)
      const age = now - (item.markedAt || 0)
      if (age < maxAge) {
        const rec = record(keyId)
        rec.state = item.state
        rec.reason = item.reason
        rec.message = item.message
        rec.lastErrorAt = item.markedAt
      }
    }
  } catch {}
}

function blank(keyId) {
  return {
    keyId,
    state: "healthy",
    reason: null,
    message: null,
    consecutiveFailures: 0,
    // Total non-responses in a row (transport-level), for dead detection.
    consecutiveNoResponse: 0,
    // Consecutive transient key errors (5xx / 408 / other >=400). After N in a
    // row the provider has effectively dropped out, so pull it (dead) so the
    // router stops re-trying it first and moves down the pool. The revive probe
    // re-enters it once it answers cleanly again.
    consecutiveErrors: 0,
    cooldownUntil: 0,
    cooldownAttempt: 0,
    lastUsedAt: null,
    lastOkAt: null,
    lastErrorAt: null,
    calls: 0,
    successes: 0,
    failures: 0,
    tokensIn: 0,
    tokensOut: 0,
    latencies: [], // rolling window for p50
  }
}

function record(keyId) {
  loadStickyState()
  if (!states.has(keyId)) states.set(keyId, blank(keyId))
  return states.get(keyId)
}

// Cooldown expiry is lazy: checked on read rather than by a timer, so there are
// no stray timers and restarts behave identically.
function effectiveState(rec) {
  if (rec.state === "cooling" && Date.now() >= rec.cooldownUntil) return "healthy"
  return rec.state
}

function isUsable(keyId) {
  const rec = record(keyId)
  const s = effectiveState(rec)
  return s === "healthy" || s === "degraded"
}

function markUsed(keyId) {
  const rec = record(keyId)
  rec.lastUsedAt = Date.now()
  rec.calls++
}

function markSuccess(keyId, { latencyMs, tokensIn = 0, tokensOut = 0 } = {}) {
  const rec = record(keyId)
  rec.state = "healthy"
  rec.reason = null
  rec.message = null
  rec.consecutiveFailures = 0
  rec.consecutiveNoResponse = 0
  rec.consecutiveErrors = 0
  rec.cooldownUntil = 0
  rec.cooldownAttempt = 0
  rec.lastOkAt = Date.now()
  rec.successes++
  rec.tokensIn += tokensIn
  rec.tokensOut += tokensOut
  if (typeof latencyMs === "number") {
    rec.latencies.push(latencyMs)
    if (rec.latencies.length > 200) rec.latencies.shift()
  }
  return rec
}

/**
 * Apply a classification result to a key.
 * @param {string} keyId
 * @param {{reason:string,keyState:string,message:string}} verdict from classify()
 */
function markFailure(keyId, verdict) {
  const rec = record(keyId)
  const settings = config.load().settings
  rec.failures++
  rec.consecutiveFailures++
  rec.lastErrorAt = Date.now()
  rec.reason = verdict.reason
  rec.message = verdict.message

  const transport = verdict.reason === "connection_failed" || verdict.reason === "timeout"
  rec.consecutiveNoResponse = transport ? rec.consecutiveNoResponse + 1 : 0

  // "Didn't respond at all after all the tests" — promote to dead.
  if (transport && rec.consecutiveNoResponse >= settings.deadAfterFailures) {
    rec.state = "dead"
    rec.consecutiveErrors = 0
    saveStickyState()
    return rec
  }

  if (verdict.keyState === "cooling") {
    rec.cooldownAttempt++
    const base = settings.cooldownBaseSeconds * 2 ** (rec.cooldownAttempt - 1)
    const seconds = Math.min(base, settings.cooldownMaxSeconds)
    rec.cooldownUntil = Date.now() + seconds * 1000
    rec.state = "cooling"
    rec.consecutiveErrors = 0
    return rec
  }

  // Leg-scoped problems (model missing here, our own bad headers) are not the
  // key's fault; leave its state alone so it stays usable for other models.
  if (verdict.keyState === "healthy") return rec

  // Transient key errors (5xx, 408, other >=400). A provider that keeps
  // returning these has effectively dropped out, so pull it (dead) once the
  // streak hits the threshold — the router then stops re-trying it first and
  // moves down the pool. The revive probe re-enters it after it answers a
  // clean probe again.
  if (verdict.keyState === "degraded") {
    rec.consecutiveErrors += 1
    if (rec.consecutiveErrors >= (settings.errorPullAfterFailures ?? 3)) {
      rec.state = "dead"
      return rec
    }
    rec.state = "degraded"
    return rec
  }

  // Sticky states (exhausted / auth_failed) pull immediately.
  rec.consecutiveErrors = 0
  rec.state = verdict.keyState
  return rec
}

// Explicitly return a key to rotation (dashboard action, or key value edited).
function clear(keyId) {
  const rec = record(keyId)
  const keep = {
    calls: rec.calls,
    successes: rec.successes,
    failures: rec.failures,
    tokensIn: rec.tokensIn,
    tokensOut: rec.tokensOut,
    latencies: rec.latencies,
  }
  states.set(keyId, Object.assign(blank(keyId), keep))
  saveStickyState()
  return states.get(keyId)
}

// Return every sticky key to rotation (manual "restart rotation" action).
// Counters are kept; only the state flag resets, so the next request tries the
// first provider again from the top.
function clearSticky() {
  for (const keyId of [...states.keys()]) {
    if (STICKY.has(effectiveState(states.get(keyId)))) clear(keyId)
  }
  saveStickyState()
}

function forget(keyId) {
  states.delete(keyId)
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function snapshot(keyId) {
  const rec = record(keyId)
  const sorted = [...rec.latencies].sort((a, b) => a - b)
  const state = effectiveState(rec)
  return {
    keyId,
    state,
    sticky: STICKY.has(state),
    reason: rec.reason,
    message: rec.message,
    usable: state === "healthy" || state === "degraded",
    cooldownRemainingMs: state === "cooling" ? Math.max(0, rec.cooldownUntil - Date.now()) : 0,
    calls: rec.calls,
    successes: rec.successes,
    failures: rec.failures,
    successRate: rec.calls ? rec.successes / rec.calls : null,
    tokensIn: rec.tokensIn,
    tokensOut: rec.tokensOut,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    lastUsedAt: rec.lastUsedAt,
    lastOkAt: rec.lastOkAt,
    lastErrorAt: rec.lastErrorAt,
  }
}

function all() {
  return [...states.keys()].map(snapshot)
}

function reset() {
  states.clear()
  loadedPersisted = false
}

module.exports = {
  isUsable,
  markUsed,
  markSuccess,
  markFailure,
  clear,
  clearSticky,
  forget,
  snapshot,
  all,
  reset,
  effectiveState,
  record,
  STICKY,
  flushStickySync,
}
