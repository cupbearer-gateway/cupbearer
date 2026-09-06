"use strict"
// DOC: ../docs/architecture.md → § Module map → server/health.js

// Failure state machine, scoped.
//
// State is derived from real traffic, not background probing — accurate and
// free. States live in memory (they are observations, not configuration) and are
// rebuilt naturally as requests flow.
//
// Two scopes, because upstream failures are not all about the same thing:
//
//   key-scoped     states about the CREDENTIAL itself or the connection to the
//                  provider: auth_failed (rejected), dead (transport silence),
//                  cooling (rate limited). These pull the key from every model
//                  it serves — correctly, because the credential or the
//                  provider being down hits all of them.
//
//   model-scoped   states about ONE model route on ONE key: exhausted (that
//                  model's budget pool is empty), unavailable (no channel for
//                  this model here), dead (this model keeps erroring on this
//                  key). Keyed by "keyId@model"; pulling the (key, model) pair
//                  leaves the same key serving its other models.
//
// The scoping rule follows classify()'s verdict scope: "key" -> key record,
// "leg" -> per-(key, model) record. Quota refusals are leg-scoped by design:
// observed at agentrouter and tabitoken, a model's budget pool empties while
// the same key keeps answering 200 for its other models.
//
// Model-scoped states:
//   exhausted    this model's budget/quota on this key is spent; pulled. Sticky.
//                Top-up is picked up by the revive probe, which re-tests with
//                the exact model that failed.
//   unavailable  the provider cannot serve this model right now (no channel,
//                model retired/gated, protocol mismatch). Soft-sticky: expires
//                on its own (TTL) and the revive probe re-tests it, so a
//                channel that comes back is picked up without manual action.
//   dead         N consecutive degraded failures on this (key, model); pulled
//                like key-level dead, revive re-tests it.
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
  unavailable: 30 * 60 * 1000,
}

// Separator for the "keyId@model" composite key. Key ids are "provider:key-N"
// and never contain @, so this cannot collide.
const SEP = "@"

// keyId -> record
const states = new Map()
// "keyId@model" -> model-scoped record
const modelStates = new Map()
let saveTimer = null
let loadedPersisted = false

function keyFor(keyId, model) {
  return `${keyId}${SEP}${model}`
}

function modelScoped(verdict, model) {
  return verdict?.scope === "leg" && Boolean(model)
}

function flushStickySync() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const persisted = {}
    const now = Date.now()

    // Key-level sticky states.
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

    // Model-scoped non-healthy states (sticky or soft-sticky).
    for (const [key, rec] of modelStates.entries()) {
      const s = effectiveState(rec)
      if (s !== "healthy") {
        persisted[key] = {
          keyId: rec.keyId,
          model: rec.model,
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

// Only (re)trigger persistence after a debounce gap; sticky transitions call
// this, and debouncing batches bursts of failures into one disk write.
// (saveStickyState is the exported name; internal callers use it directly.)

function loadStickyState() {
  if (loadedPersisted) return
  loadedPersisted = true
  try {
    if (!fs.existsSync(HEALTH_STATE_FILE)) return
    const raw = fs.readFileSync(HEALTH_STATE_FILE, "utf8")
    const persisted = JSON.parse(raw)
    const now = Date.now()

    for (const [key, item] of Object.entries(persisted)) {
      if (!STICKY.has(item.state) && item.state !== "unavailable") continue
      const maxAge = TTL_MS[item.state] || (12 * 3600 * 1000)
      const age = now - (item.markedAt || 0)
      if (age >= maxAge) continue
      if (item.model) {
        const rec = modelRecord(item.keyId || key.split(SEP)[0], item.model)
        applyPersisted(rec, item, item.keyId || key.split(SEP)[0], item.model)
      } else {
        const rec = record(key)
        rec.state = item.state
        rec.reason = item.reason
        rec.message = item.message
        rec.lastErrorAt = item.markedAt
      }
    }
  } catch {}
}

function applyPersisted(rec, item, keyId, model) {
  rec.state = item.state
  rec.reason = item.reason
  rec.message = item.message
  rec.lastErrorAt = item.markedAt
  rec.keyId = keyId
  rec.model = model
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

// Model-scoped records carry only state, not stats: counters and latency stay
// per key so key ordering and the dashboard's per-key numbers keep their shape.
function blankModel(keyId, model) {
  return {
    keyId,
    model,
    state: "healthy",
    reason: null,
    message: null,
    consecutiveErrors: 0,
    consecutiveNoResponse: 0,
    lastErrorAt: null,
  }
}

function record(keyId) {
  loadStickyState()
  if (!states.has(keyId)) states.set(keyId, blank(keyId))
  return states.get(keyId)
}

function modelRecord(keyId, model) {
  loadStickyState()
  const key = keyFor(keyId, model)
  if (!modelStates.has(key)) modelStates.set(key, blankModel(keyId, model))
  return modelStates.get(key)
}

// Cooldown expiry is lazy: checked on read rather than by a timer, so there are
// no stray timers and restarts behave identically.
function effectiveState(rec) {
  if (rec.state === "cooling" && Date.now() >= rec.cooldownUntil) return "healthy"
  if (rec.model && rec.state === "unavailable" && Date.now() - (rec.lastErrorAt || 0) >= TTL_MS.unavailable) return "healthy"
  return rec.state
}

function isUsable(keyId, model) {
  const s = effectiveState(record(keyId))
  if (s !== "healthy" && s !== "degraded") return false
  if (model) {
    const ms = effectiveState(modelRecord(keyId, model))
    if (ms !== "healthy" && ms !== "degraded") return false
  }
  return true
}

function markUsed(keyId) {
  const rec = record(keyId)
  rec.lastUsedAt = Date.now()
  rec.calls++
}

function markSuccess(keyId, { latencyMs, tokensIn = 0, tokensOut = 0 } = {}, model) {
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
  // A working call also clears whatever was wrong with this model route on the
  // key — the pool that burned the attempt learned the truth the hard way.
  if (model) {
    const ms = modelRecord(keyId, model)
    ms.state = "healthy"
    ms.reason = null
    ms.message = null
    ms.consecutiveErrors = 0
    ms.consecutiveNoResponse = 0
  }
  return rec
}

/**
 * Apply a classification result to a key and/or the (key, model) route.
 * @param {string} keyId
 * @param {{reason:string,keyState:string,scope?:string,message:string}} verdict from classify()
 * @param {string} [model]  the model the failure happened on; required for
 *                          leg-scoped verdicts, ignored for key-scoped ones
 */
function markFailure(keyId, verdict, model) {
  const keyRec = record(keyId)
  const settings = config.load().settings
  keyRec.failures++
  keyRec.consecutiveFailures++
  const scoped = modelScoped(verdict, model)

  // Cooling is always key-scoped: rate limits at these gateways are per token.
  if (verdict.keyState === "cooling") {
    keyRec.cooldownAttempt++
    const base = settings.cooldownBaseSeconds * 2 ** (keyRec.cooldownAttempt - 1)
    const seconds = Math.min(base, settings.cooldownMaxSeconds)
    keyRec.cooldownUntil = Date.now() + seconds * 1000
    keyRec.state = "cooling"
    keyRec.consecutiveErrors = 0
    return keyRec
  }

  // Leg-scoped verdicts live on the (key, model) record and must not touch the
  // key-level state: the key stays usable for its other models.
  if (scoped) {
    const rec = modelRecord(keyId, model)
    rec.lastErrorAt = Date.now()
    rec.reason = verdict.reason
    rec.message = verdict.message

    if (verdict.keyState === "exhausted") {
      rec.state = "exhausted"
      rec.consecutiveErrors = 0
      saveStickyState()
      return rec
    }

    // Model problems that are not the key's fault (no channel, model retired,
    // protocol mismatch): remember the route is unusable so the router skips it
    // without burning an attempt on every request, and let the revive probe
    // (which re-tests with the exact model) clear it when the provider fixes it.
    if (verdict.keyState === "healthy") {
      rec.consecutiveErrors = 0
      rec.state = "unavailable"
      saveStickyState()
      return rec
    }

    // Degraded: a streak of these on this model route pulls the pair.
    if (verdict.keyState === "degraded") {
      rec.consecutiveErrors += 1
      if (rec.consecutiveErrors >= (settings.errorPullAfterFailures ?? 3)) {
        rec.state = "dead"
        rec.consecutiveErrors = 0
        saveStickyState()
        return rec
      }
      rec.state = "degraded"
      return rec
    }

    // auth_failed is key-scoped by class: a rejected credential is rejected
    // everywhere. If a leg-scoped verdict somehow carries it, stay conservative
    // and treat it as key-level below.
  }

  const rec = keyRec
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
      saveStickyState()
      return rec
    }
    rec.state = "degraded"
    return rec
  }

  // Sticky states (exhausted / auth_failed) pull immediately.
  rec.consecutiveErrors = 0
  rec.state = verdict.keyState
  saveStickyState()
  return rec
}

// Explicitly return a key to rotation (dashboard action, or key value edited).
function clear(keyId) {
  clearKeyLevel(keyId)
  for (const [key, mrec] of [...modelStates.entries()]) {
    if (mrec.keyId === keyId) modelStates.delete(key)
  }
  saveStickyState()
  return states.get(keyId)
}

// Resets only the key-level record (credential / connection facts), keeping the
// per-model pulls intact. Used by the revive probe: a successful probe proves
// the credential, not that every model's budget pool has been topped up.
function clearKeyLevel(keyId) {
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

// Clear only the (key, model) record — used by the revive probe, which re-tests
// with the exact model that failed and must not resurrect other routes.
function clearModel(keyId, model) {
  modelStates.delete(keyFor(keyId, model))
  saveStickyState()
}

// Return every sticky key to rotation (manual "restart rotation" action).
// Counters are kept; only the state flag resets, so the next request tries the
// first provider again from the top.
function clearSticky() {
  for (const keyId of [...states.keys()]) {
    if (STICKY.has(effectiveState(states.get(keyId)))) clear(keyId)
  }
  for (const [key, rec] of [...modelStates.entries()]) {
    if (STICKY.has(effectiveState(rec)) || effectiveState(rec) === "unavailable") {
      modelStates.delete(key)
    }
  }
  saveStickyState()
}

function forget(keyId) {
  states.delete(keyId)
  for (const [key, rec] of [...modelStates.entries()]) {
    if (rec.keyId === keyId) modelStates.delete(key)
  }
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
  const modelScoped = []
  for (const [key, mrec] of modelStates.entries()) {
    if (mrec.keyId !== keyId) continue
    const ms = effectiveState(mrec)
    if (ms === "healthy") continue
    modelScoped.push({
      model: mrec.model,
      state: ms,
      sticky: STICKY.has(ms),
      reason: mrec.reason,
      message: mrec.message,
      lastErrorAt: mrec.lastErrorAt,
    })
  }
  return {
    keyId,
    state,
    sticky: STICKY.has(state) || modelScoped.some((m) => m.sticky || m.state === "unavailable"),
    reason: rec.reason,
    message: rec.message,
    usable: isUsable(keyId),
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
    // Per-model routes that are pulled while the key itself stays in rotation.
    modelStates: modelScoped,
  }
}

function all() {
  return [...states.keys()].map(snapshot)
}

function reset() {
  states.clear()
  modelStates.clear()
  loadedPersisted = false
}

module.exports = {
  isUsable,
  markUsed,
  markSuccess,
  markFailure,
  clear,
  clearKeyLevel,
  clearModel,
  clearSticky,
  forget,
  snapshot,
  all,
  reset,
  effectiveState,
  record,
  modelRecord,
  STICKY,
  flushStickySync,
}