"use strict"
// DOC: ../docs/architecture.md → § Module map → server/config.js · ../docs/operations.md → § Backup / restore

// Config store: pools + providers. Never holds key values (see secrets.js).
//
// Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
// truncated config behind. An in-memory copy is the read path; disk is only
// touched on load and on mutation.

const fs = require("fs")
const path = require("path")
const { CONFIG_FILE } = require("./paths")

const DEFAULT_CONFIG = {
  version: 1,
  providers: [],
  pools: [],
  settings: {
    // Seconds a rate-limited key waits before re-entering rotation.
    cooldownBaseSeconds: 20,
    cooldownMaxSeconds: 600,
    // Consecutive total non-responses before a key is called dead.
    deadAfterFailures: 3,
    // Consecutive transient errors (5xx / 408 / other >=400) before a key is
    // pulled (dead) so the router stops re-trying it first and moves down the
    // pool. Self-heals via the revive probe once the provider answers again.
    errorPullAfterFailures: 3,
    // Desktop toast whenever a request switches key or provider (rate limit,
    // key exhausted, rejected key, …) or the pool is down.
    notifyFailover: true,
    // Minutes to wait before the same source (pool/provider, or pool/key) can
    // toast again. 0 fires on every switch (a 2s global gap still applies).
    notifyCooldownMinutes: 2,
    // Background re-probe of sticky keys (exhausted / rejected / dead) so a
    // recovered provider comes back into rotation on its own.
    reviveProbe: true,
    reviveIntervalMinutes: 5,
    // --- time budgets -------------------------------------------------------
    // Ceiling on ONE attempt's wait for the upstream's first response. Measured
    // over 3380 successful calls: p50 5.1s, p95 25.7s, p99 68.8s, and no
    // provider in any pool needs more. The old 300s bought that last ~1% at the
    // cost of parking a dead provider for five minutes (observed 9 times, and
    // client-side turn failures at 310s and 330s).
    attemptTimeoutMs: 90000,
    // Ceiling on the WHOLE request, across every key and leg. Without it the
    // chain is unbounded: deepseek-v4-flash alone is 4 legs / 16 keys, so 16
    // attempts x 300s was an 80-minute worst case. Attempts are clamped to what
    // is left, and no new attempt starts once the remainder is too small to be
    // worth it.
    requestBudgetMs: 180000,
    // Wait for the FIRST stream byte. Nothing is committed yet, so abandoning is
    // free and recoverable — measured time-to-first-byte is within 1ms of the
    // response headers on every provider here (they buffer), so a wait this long
    // means the stream is dead, not slow.
    firstChunkTimeoutMs: 30000,
    // Wait for the NEXT byte once a stream is flowing. The client already holds
    // output, so this can only be reported, never retried; kept generous because
    // a model may legitimately pause between tool calls.
    chunkTimeoutMs: 60000,
    // Maximum number of keys per provider tried in one request attempt
    maxKeysPerLeg: 8,
    // Maximum sticky keys probed per revive cycle
    reviveMaxPerTick: 20,
    // Background health canary probe of healthy keys
    canaryEnabled: false,
    canaryIntervalMinutes: 15,
    // JSONL log retention in days
    metricsRetainDays: 14,
  },
}

let cache = null

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

// ---------------------------------------------------------------- persistence

function load() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8")
    const parsed = JSON.parse(raw)
    cache = { ...clone(DEFAULT_CONFIG), ...parsed }
    cache.settings = { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) }
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Refuse to silently clobber a config we failed to parse.
      throw new Error(`cupbearer: ${CONFIG_FILE} exists but is unreadable: ${e.message}`)
    }
    cache = clone(DEFAULT_CONFIG)
  }
  return cache
}

function save(next) {
  const errors = validate(next)
  if (errors.length) throw new Error(`cupbearer: invalid config:\n  - ${errors.join("\n  - ")}`)

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, CONFIG_FILE)
  cache = next
  return cache
}

// Read-modify-write under a single validation pass.
function update(mutator) {
  const next = clone(load())
  mutator(next)
  return save(next)
}

// ----------------------------------------------------------------- validation

// What a pool leg may declare as a hard capability (router filters on these).
const KNOWN_CAPABILITIES = new Set(["tools", "vision", "long-context"])

function validate(cfg) {
  const errors = []
  if (!Array.isArray(cfg.providers)) errors.push("providers must be an array")
  if (!Array.isArray(cfg.pools)) errors.push("pools must be an array")
  if (errors.length) return errors

  if (cfg.settings && typeof cfg.settings === "object") {
    const knownSettings = new Set(Object.keys(DEFAULT_CONFIG.settings))
    for (const key of Object.keys(cfg.settings)) {
      if (!knownSettings.has(key)) {
        errors.push(`unknown setting "${key}"`)
      }
    }

    const s = { ...DEFAULT_CONFIG.settings, ...cfg.settings }

    if (typeof s.cooldownBaseSeconds !== "number" || s.cooldownBaseSeconds < 1 || s.cooldownBaseSeconds > 3600) {
      errors.push("settings.cooldownBaseSeconds must be a number between 1 and 3600")
    }
    if (typeof s.cooldownMaxSeconds !== "number" || s.cooldownMaxSeconds < s.cooldownBaseSeconds || s.cooldownMaxSeconds > 86400) {
      errors.push("settings.cooldownMaxSeconds must be >= cooldownBaseSeconds and <= 86400")
    }
    if (typeof s.deadAfterFailures !== "number" || s.deadAfterFailures < 1 || s.deadAfterFailures > 20) {
      errors.push("settings.deadAfterFailures must be a number between 1 and 20")
    }
    if (typeof s.errorPullAfterFailures !== "number" || s.errorPullAfterFailures < 1 || s.errorPullAfterFailures > 20) {
      errors.push("settings.errorPullAfterFailures must be a number between 1 and 20")
    }
    if (typeof s.notifyFailover !== "boolean") {
      errors.push("settings.notifyFailover must be a boolean")
    }
    if (typeof s.notifyCooldownMinutes !== "number" || s.notifyCooldownMinutes < 0 || s.notifyCooldownMinutes > 1440) {
      errors.push("settings.notifyCooldownMinutes must be a number between 0 and 1440")
    }
    if (typeof s.reviveProbe !== "boolean") {
      errors.push("settings.reviveProbe must be a boolean")
    }
    if (typeof s.reviveIntervalMinutes !== "number" || s.reviveIntervalMinutes < 1 || s.reviveIntervalMinutes > 1440) {
      errors.push("settings.reviveIntervalMinutes must be a number between 1 and 1440")
    }
    if (typeof s.attemptTimeoutMs !== "number" || s.attemptTimeoutMs < 500 || s.attemptTimeoutMs > 600000) {
      errors.push("settings.attemptTimeoutMs must be a number between 500 and 600000")
    }
    if (typeof s.requestBudgetMs !== "number" || s.requestBudgetMs < 1000 || s.requestBudgetMs > 1800000) {
      errors.push("settings.requestBudgetMs must be a number between 1000 and 1800000")
    }
    if (s.attemptTimeoutMs > s.requestBudgetMs) {
      errors.push("settings.attemptTimeoutMs cannot exceed settings.requestBudgetMs")
    }
    if (typeof s.firstChunkTimeoutMs !== "number" || s.firstChunkTimeoutMs < 500 || s.firstChunkTimeoutMs > s.attemptTimeoutMs) {
      errors.push("settings.firstChunkTimeoutMs must be between 500 and attemptTimeoutMs")
    }
    if (typeof s.chunkTimeoutMs !== "number" || s.chunkTimeoutMs < 500 || s.chunkTimeoutMs > 600000) {
      errors.push("settings.chunkTimeoutMs must be a number between 500 and 600000")
    }
    if (typeof s.maxKeysPerLeg !== "number" || s.maxKeysPerLeg < 1 || s.maxKeysPerLeg > 100) {
      errors.push("settings.maxKeysPerLeg must be a number between 1 and 100")
    }
    if (typeof s.reviveMaxPerTick !== "number" || s.reviveMaxPerTick < 1 || s.reviveMaxPerTick > 100) {
      errors.push("settings.reviveMaxPerTick must be a number between 1 and 100")
    }
    if (typeof s.canaryEnabled !== "boolean") {
      errors.push("settings.canaryEnabled must be a boolean")
    }
    if (typeof s.canaryIntervalMinutes !== "number" || s.canaryIntervalMinutes < 1 || s.canaryIntervalMinutes > 1440) {
      errors.push("settings.canaryIntervalMinutes must be a number between 1 and 1440")
    }
    if (typeof s.metricsRetainDays !== "number" || s.metricsRetainDays < 1 || s.metricsRetainDays > 90) {
      errors.push("settings.metricsRetainDays must be a number between 1 and 90")
    }
  }

  const providerIds = new Set()
  const globalKeyIds = new Set()

  for (const p of cfg.providers) {
    if (!p.id) errors.push("provider missing id")
    else if (providerIds.has(p.id)) errors.push(`duplicate provider id: ${p.id}`)
    else providerIds.add(p.id)
    if (!p.baseURL) errors.push(`provider ${p.id}: missing baseURL`)
    else {
      try {
        const u = new URL(p.baseURL)
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          errors.push(`provider ${p.id}: baseURL must use http or https protocol`)
        }
      } catch {
        errors.push(`provider ${p.id}: invalid baseURL "${p.baseURL}"`)
      }
    }
    if (!Array.isArray(p.models)) errors.push(`provider ${p.id}: models must be an array`)
    if (!Array.isArray(p.keys)) errors.push(`provider ${p.id}: keys must be an array`)

    for (const k of p.keys || []) {
      if (!k.id) errors.push(`provider ${p.id}: key missing id`)
      else if (globalKeyIds.has(k.id)) errors.push(`duplicate key id across providers: ${k.id}`)
      else globalKeyIds.add(k.id)
    }
  }

  const poolIds = new Set()
  const validStrategies = new Set(["round-robin", "sticky-until-error", "fastest-first", "quality"])

  for (const pool of cfg.pools) {
    if (!pool.id) errors.push("pool missing id")
    else if (poolIds.has(pool.id)) errors.push(`duplicate pool id: ${pool.id}`)
    else poolIds.add(pool.id)
    if (!/^[a-zA-Z0-9._-]+$/.test(pool.id || "")) {
      errors.push(`pool ${pool.id}: id must contain only letters, digits, dot, dash, underscore`)
    }
    if (pool.keyStrategy && !validStrategies.has(pool.keyStrategy)) {
      errors.push(`pool ${pool.id}: invalid keyStrategy "${pool.keyStrategy}"`)
    }
    if (!Array.isArray(pool.legs) || pool.legs.length === 0) {
      errors.push(`pool ${pool.id}: needs at least one leg`)
      continue
    }
    for (const leg of pool.legs) {
      if (!providerIds.has(leg.providerId)) {
        errors.push(`pool ${pool.id}: leg references unknown provider ${leg.providerId}`)
      }
      if (!leg.model) errors.push(`pool ${pool.id}: leg on ${leg.providerId} missing model`)
      if (leg.tier !== undefined && (!Number.isInteger(leg.tier) || leg.tier < 1 || leg.tier > 3)) {
        errors.push(`pool ${pool.id}: leg tier must be an integer 1..3 (1 flagship, 2 standard, 3 light)`)
      }
      if (leg.capabilities !== undefined) {
        if (!Array.isArray(leg.capabilities)) {
          errors.push(`pool ${pool.id}: leg capabilities must be an array`)
        } else {
          const bad = leg.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c))
          if (bad.length) errors.push(`pool ${pool.id}: unknown leg capability: ${bad.join(", ")}`)
        }
      }
    }
  }

  // A pool id colliding with a provider id would make routing ambiguous.
  for (const id of poolIds) {
    if (providerIds.has(id)) errors.push(`pool id ${id} collides with a provider id`)
  }

  return errors
}

// -------------------------------------------------------------------- helpers

function getProvider(id) {
  return load().providers.find((p) => p.id === id) || null
}

function getPool(id) {
  return load().pools.find((p) => p.id === id) || null
}

// Providers that are configured but parked (revoked key, disabled account).
// Kept in config so their model lists survive; skipped by the router.
function isProviderUsable(p) {
  return p && p.enabled !== false
}

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function reset() {
  cache = null
}

module.exports = {
  DEFAULT_CONFIG,
  load,
  save,
  update,
  validate,
  getProvider,
  getPool,
  isProviderUsable,
  slugify,
  reset,
}
