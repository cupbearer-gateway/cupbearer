"use strict"
// DOC: ../docs/api.md → § Dashboard API · § SSE events

// Dashboard REST API. Loopback-only; there is no auth layer, so the bind
// address is the security boundary (see index.js).
//
// Key values are write-only through this API: they go in via POST/PUT and come
// back only as masks.

const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const metrics = require("./metrics")
const events = require("./events")
const quirks = require("./quirks")
const upstream = require("./upstream")
const router = require("./router")
const canary = require("./canary")
const revive = require("./revive")
const store = require("./store")
const { json, error, readJsonBody } = require("./http-util")

// ---------------------------------------------------------------- serialisers

function keyView(providerId, key) {
  const snap = health.snapshot(key.id)
  return {
    id: key.id,
    label: key.label || key.id,
    providerId,
    masked: secrets.mask(key.id),
    present: secrets.has(key.id),
    addedAt: key.addedAt || null,
    ...snap,
  }
}

function providerView(p, { slim = false } = {}) {
  const keys = (p.keys || []).map((k) => keyView(p.id, k))
  const usable = keys.filter((k) => k.usable).length
  const stateCounts = { healthy: 0, cooling: 0, degraded: 0, exhausted: 0, auth_failed: 0, dead: 0 }
  for (const k of keys) {
    if (stateCounts[k.state] !== undefined) stateCounts[k.state]++
  }
  return {
    id: p.id,
    label: p.label || p.id,
    baseURL: p.baseURL,
    adapter: p.adapter || "openai",
    quirks: p.quirks || [],
    models: p.models || [],
    enabled: p.enabled !== false,
    disabledReason: p.disabledReason || null,
    note: p.note || "",
    keys: slim ? stateCounts : keys,
    keyCount: keys.length,
    usableKeyCount: usable,
  }
}

function poolView(p, { slim = false } = {}) {
  const legs = p.legs.map((leg) => {
    const provider = config.getProvider(leg.providerId)
    const keys = provider ? (provider.keys || []).map((k) => keyView(provider.id, k)) : []
    const usableCount = keys.filter((k) => k.usable).length
    return {
      providerId: leg.providerId,
      providerLabel: provider?.label || leg.providerId,
      providerEnabled: provider ? provider.enabled !== false : false,
      model: leg.model,
      tier: leg.tier ?? null,
      capabilities: leg.capabilities || [],
      exists: Boolean(provider),
      keys: slim ? undefined : keys,
      usableKeyCount: usableCount,
      keyCount: keys.length,
    }
  })
  return {
    id: p.id,
    name: p.name || p.id,
    keyStrategy: p.keyStrategy || "round-robin",
    legs,
    stats: metrics.poolSummary(p.id),
    health: {
      usableLegs: legs.filter((l) => l.providerEnabled && l.usableKeyCount > 0).length,
      totalLegs: legs.length,
      usableKeys: legs.reduce((n, l) => n + l.usableKeyCount, 0),
      totalKeys: legs.reduce((n, l) => n + l.keyCount, 0),
    },
  }
}

// ------------------------------------------------------------------- mutations

function nextKeyId(provider) {
  const used = new Set((provider.keys || []).map((k) => k.id))
  for (let n = 1; ; n++) {
    const id = `${provider.id}:key-${n}`
    if (!used.has(id)) return id
  }
}

// API leg payload -> stored leg. tier/capabilities are optional; when absent
// the leg routes exactly as it did before tiered routing existed.
function legFromApi(l) {
  const leg = { providerId: l.providerId, model: l.model }
  if (l.tier !== undefined) leg.tier = l.tier
  if (Array.isArray(l.capabilities)) leg.capabilities = l.capabilities
  return leg
}

// --------------------------------------------------------------------- routing

async function handle(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean)
  const method = req.method

  // ---- events -------------------------------------------------------------
  if (seg[0] === "events" && method === "GET") {
    events.subscribe(res)
    return true
  }

  // ---- overview -----------------------------------------------------------
  if (seg[0] === "overview" && method === "GET") {
    const cfg = config.load()
    json(res, 200, {
      pools: cfg.pools.map(poolView),
      providers: cfg.providers.map(providerView),
      quirks: quirks.list(),
      stats: metrics.overall(),
      settings: cfg.settings,
      canary: canary.getStatus(),
    })
    return true
  }

  // ---- pools --------------------------------------------------------------
  if (seg[0] === "pools") {
    if (!seg[1] && method === "GET") {
      json(res, 200, { pools: config.load().pools.map(poolView) })
      return true
    }

    if (!seg[1] && method === "POST") {
      const body = await readJsonBody(req)
      const name = String(body.name || "").trim()
      if (!name) return error(res, 400, "pool name is required"), true
      const id = String(body.id || config.slugify(name))
      if (config.getPool(id)) return error(res, 409, `pool "${id}" already exists`), true
      if (!Array.isArray(body.legs) || !body.legs.length) {
        return error(res, 400, "a pool needs at least one leg"), true
      }
      config.update((cfg) => {
        cfg.pools.push({
          id,
          name,
          keyStrategy: body.keyStrategy || "round-robin",
          legs: body.legs.map(legFromApi),
        })
      })
      router.resetCursors()
      events.emit("pools", { action: "created", id })
      json(res, 201, { pool: poolView(config.getPool(id)) })
      return true
    }

    const poolId = seg[1] ? decodeURIComponent(seg[1]) : null

    if (poolId && seg[2] === "detail" && method === "GET") {
      const pool = config.getPool(poolId)
      if (!pool) return error(res, 404, `no pool "${poolId}"`), true
      json(res, 200, {
        pool: poolView(pool),
        series: metrics.series(poolId, 60),
        feed: metrics.feed(60, poolId),
      })
      return true
    }

    if (poolId && !seg[2] && method === "PUT") {
      const pool = config.getPool(poolId)
      if (!pool) return error(res, 404, `no pool "${poolId}"`), true
      const body = await readJsonBody(req)
      config.update((cfg) => {
        const p = cfg.pools.find((x) => x.id === poolId)
        if (body.name !== undefined) p.name = String(body.name).trim()
        if (body.keyStrategy !== undefined) p.keyStrategy = body.keyStrategy
        if (Array.isArray(body.legs)) {
          p.legs = body.legs.map(legFromApi)
        }
      })
      router.resetCursors()
      events.emit("pools", { action: "updated", id: poolId })
      json(res, 200, { pool: poolView(config.getPool(poolId)) })
      return true
    }

    if (poolId && !seg[2] && method === "DELETE") {
      if (!config.getPool(poolId)) return error(res, 404, `no pool "${poolId}"`), true
      config.update((cfg) => {
        cfg.pools = cfg.pools.filter((p) => p.id !== poolId)
      })
      router.resetCursors()
      events.emit("pools", { action: "deleted", id: poolId })
      json(res, 200, { ok: true })
      return true
    }
  }

  // ---- providers ----------------------------------------------------------
  if (seg[0] === "providers") {
    if (!seg[1] && method === "GET") {
      json(res, 200, { providers: config.load().providers.map(providerView), quirks: quirks.list() })
      return true
    }

    if (!seg[1] && method === "POST") {
      const body = await readJsonBody(req)
      const id = String(body.id || config.slugify(body.label || "")).trim()
      if (!id) return error(res, 400, "provider id or label is required"), true
      if (config.getProvider(id)) return error(res, 409, `provider "${id}" already exists`), true
      if (!body.baseURL) return error(res, 400, "baseURL is required"), true

      const bad = quirks.unknown(body.quirks || [])
      if (bad.length) return error(res, 400, `unknown quirks: ${bad.join(", ")}`), true

      // Accept keys as [{label, value}] and split them into config + secrets.
      const incoming = Array.isArray(body.keys) ? body.keys : []
      const keyRecords = []
      const keyValues = {}
      incoming.forEach((k, i) => {
        if (!k?.value) return
        const keyId = `${id}:key-${i + 1}`
        keyRecords.push({ id: keyId, label: k.label || `Key ${i + 1}`, addedAt: new Date().toISOString() })
        keyValues[keyId] = k.value
      })

      config.update((cfg) => {
        cfg.providers.push({
          id,
          label: body.label || id,
          baseURL: body.baseURL,
          adapter: body.adapter || "openai",
          quirks: body.quirks || [],
          models: Array.isArray(body.models) ? body.models : [],
          enabled: body.enabled !== false,
          disabledReason: body.disabledReason || null,
          note: body.note || "",
          keys: keyRecords,
        })
      })
      if (Object.keys(keyValues).length) secrets.setMany(keyValues)
      events.emit("providers", { action: "created", id })
      json(res, 201, { provider: providerView(config.getProvider(id)) })
      return true
    }

    const providerId = seg[1] ? decodeURIComponent(seg[1]) : null
    const provider = providerId ? config.getProvider(providerId) : null

    if (providerId && !provider) return error(res, 404, `no provider "${providerId}"`), true

    if (provider && !seg[2] && method === "PUT") {
      const body = await readJsonBody(req)
      if (body.quirks) {
        const bad = quirks.unknown(body.quirks)
        if (bad.length) return error(res, 400, `unknown quirks: ${bad.join(", ")}`), true
      }
      config.update((cfg) => {
        const p = cfg.providers.find((x) => x.id === providerId)
        for (const f of ["label", "baseURL", "adapter", "note", "disabledReason"]) {
          if (body[f] !== undefined) p[f] = body[f]
        }
        if (body.enabled !== undefined) p.enabled = body.enabled !== false
        if (Array.isArray(body.models)) p.models = body.models
        if (Array.isArray(body.quirks)) p.quirks = body.quirks
      })
      events.emit("providers", { action: "updated", id: providerId })
      json(res, 200, { provider: providerView(config.getProvider(providerId)) })
      return true
    }

    if (provider && !seg[2] && method === "DELETE") {
      // Refuse to orphan pool legs silently.
      const affected = config.load().pools.filter((p) => p.legs.some((l) => l.providerId === providerId))
      const body = await readJsonBody(req).catch(() => ({}))
      if (affected.length && !body.force) {
        return (
          error(res, 409, `provider "${providerId}" is used by ${affected.length} pool(s)`, {
            pools: affected.map((p) => p.id),
            hint: "resend with { force: true } to remove it from those pools as well",
          }),
          true
        )
      }
      const keyIds = (provider.keys || []).map((k) => k.id)
      config.update((cfg) => {
        cfg.providers = cfg.providers.filter((p) => p.id !== providerId)
        for (const pool of cfg.pools) pool.legs = pool.legs.filter((l) => l.providerId !== providerId)
        // A pool with no legs left cannot route; drop it rather than keep a stub.
        cfg.pools = cfg.pools.filter((p) => p.legs.length > 0)
      })
      for (const id of keyIds) {
        secrets.remove(id)
        health.forget(id)
      }
      events.emit("providers", { action: "deleted", id: providerId })
      json(res, 200, { ok: true })
      return true
    }

    // ---- keys -------------------------------------------------------------
    if (provider && seg[2] === "keys") {
      if (!seg[3] && method === "GET") {
        const stateFilter = url.searchParams.get("state")
        const q = (url.searchParams.get("q") || "").toLowerCase().trim()
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)))
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0))

        let keys = (provider.keys || []).map((k) => keyView(provider.id, k))
        if (stateFilter) {
          keys = keys.filter((k) => k.state === stateFilter)
        }
        if (q) {
          keys = keys.filter((k) => k.label.toLowerCase().includes(q) || k.id.toLowerCase().includes(q))
        }

        const total = keys.length
        const page = keys.slice(offset, offset + limit)
        json(res, 200, { keys: page, total, limit, offset })
        return true
      }

      if (seg[3] === "bulk" && method === "POST") {
        const body = await readJsonBody(req)
        const incoming = Array.isArray(body.keys) ? body.keys : []
        if (!incoming.length) return error(res, 400, "keys array is required"), true

        const addedKeys = []
        const keyValues = {}

        config.update((cfg) => {
          const p = cfg.providers.find((x) => x.id === providerId)
          for (const item of incoming) {
            if (!item?.value) continue
            const val = String(item.value).trim()
            if (!val) continue
            // Skip duplicates if requested
            if (body.skipDuplicates) {
              const existingValues = new Set((p.keys || []).map((k) => secrets.get(k.id)))
              if (existingValues.has(val)) continue
            }
            const keyId = nextKeyId(p)
            const rec = {
              id: keyId,
              label: item.label || `Key ${p.keys.length + 1}`,
              addedAt: new Date().toISOString(),
            }
            p.keys.push(rec)
            keyValues[keyId] = val
            addedKeys.push(rec)
          }
        })

        if (Object.keys(keyValues).length) secrets.setMany(keyValues)
        events.emit("providers", { action: "keys-bulk-added", id: providerId, count: addedKeys.length })
        json(res, 201, { added: addedKeys.length, keys: addedKeys })
        return true
      }

      if (!seg[3] && method === "POST") {
        const body = await readJsonBody(req)
        if (!body.value) return error(res, 400, "key value is required"), true
        const keyId = nextKeyId(provider)
        config.update((cfg) => {
          const p = cfg.providers.find((x) => x.id === providerId)
          p.keys.push({
            id: keyId,
            label: body.label || `Key ${p.keys.length + 1}`,
            addedAt: new Date().toISOString(),
          })
        })
        secrets.set(keyId, body.value)
        events.emit("providers", { action: "key-added", id: providerId, keyId })
        json(res, 201, { key: keyView(providerId, config.getProvider(providerId).keys.find((k) => k.id === keyId)) })
        return true
      }

      const keyId = seg[3] ? decodeURIComponent(seg[3]) : null
      const keyRec = keyId ? (provider.keys || []).find((k) => k.id === keyId) : null
      if (keyId && !keyRec) return error(res, 404, `no key "${keyId}" on ${providerId}`), true

      if (keyRec && !seg[4] && method === "PUT") {
        const body = await readJsonBody(req)
        if (body.label !== undefined) {
          config.update((cfg) => {
            const p = cfg.providers.find((x) => x.id === providerId)
            p.keys.find((k) => k.id === keyId).label = body.label
          })
        }
        if (body.value) {
          secrets.set(keyId, body.value)
          // A replaced key deserves a clean slate.
          health.clear(keyId)
        }
        events.emit("providers", { action: "key-updated", id: providerId, keyId })
        json(res, 200, { key: keyView(providerId, config.getProvider(providerId).keys.find((k) => k.id === keyId)) })
        return true
      }

      if (keyRec && !seg[4] && method === "DELETE") {
        config.update((cfg) => {
          const p = cfg.providers.find((x) => x.id === providerId)
          p.keys = p.keys.filter((k) => k.id !== keyId)
        })
        secrets.remove(keyId)
        health.forget(keyId)
        events.emit("providers", { action: "key-deleted", id: providerId, keyId })
        json(res, 200, { ok: true })
        return true
      }

      // Manual liveness check: one ~1-token request.
      if (keyRec && seg[4] === "test" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}))
        const model = body.model || provider.models?.[0]
        if (!model) return error(res, 400, "provider has no models to test with"), true

        const applied = quirks.compose(provider.quirks || [])
        const out = await upstream.callJson({
          provider,
          keyId,
          model,
          payload: { messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
          applied,
          timeoutMs: 45000,
        })

        const { classify } = require("./classify")
        if (out.ok) {
          health.markSuccess(keyId, { latencyMs: out.latencyMs })
          json(res, 200, { ok: true, latencyMs: out.latencyMs, key: keyView(providerId, keyRec) })
        } else {
          const verdict = classify({ status: out.status, body: out.body, error: out.error })
          health.markFailure(keyId, verdict)
          json(res, 200, {
            ok: false,
            status: out.status,
            reason: verdict.reason,
            message: verdict.message,
            key: keyView(providerId, keyRec),
          })
        }
        events.emit("providers", { action: "key-tested", id: providerId, keyId })
        return true
      }

      // Reveal a key value. Loopback-only dashboard; the value is returned only
      // on this explicit call so page loads never carry secrets.
      if (keyRec && seg[4] === "value" && method === "GET") {
        json(res, 200, { value: secrets.get(keyId) || "" })
        return true
      }

      // Return a key to rotation after you have fixed whatever was wrong.
      if (keyRec && seg[4] === "clear" && method === "POST") {
        health.clear(keyId)
        events.emit("providers", { action: "key-cleared", id: providerId, keyId })
        json(res, 200, { key: keyView(providerId, keyRec) })
        return true
      }
    }

    // Refresh the provider's model list straight from its /v1/models.
    if (provider && seg[2] === "discover" && method === "POST") {
      const usable = (provider.keys || []).find((k) => secrets.has(k.id))
      if (!usable) return error(res, 400, "provider has no stored key to query with"), true
      const out = await upstream.listModels({ provider, keyId: usable.id })
      if (!out.ok) {
        return (
          json(res, 200, {
            ok: false,
            status: out.status,
            message: out.error?.message || "could not list models",
          }),
          true
        )
      }
      json(res, 200, { ok: true, models: out.models })
      return true
    }
  }

  // ---- rotation -----------------------------------------------------------
  // Manual restart: clear every sticky key and forget cursors so the next
  // request starts calling providers from the top again.
  if (seg[0] === "rotation" && seg[1] === "restart" && method === "POST") {
    health.clearSticky()
    router.resetCursors()
    events.emit("pools", { action: "rotation-restarted" })
    json(res, 200, { ok: true })
    return true
  }

  // ---- revive & canary probes ---------------------------------------------
  if (seg[0] === "revive" && seg[1] === "run" && method === "POST") {
    await revive.probeOnce()
    json(res, 200, { ok: true })
    return true
  }

  if (seg[0] === "canary" && seg[1] === "run" && method === "POST") {
    await canary.probeOnce({ force: true })
    json(res, 200, { ok: true, status: canary.getStatus() })
    return true
  }

  if (seg[0] === "canary" && seg[1] === "status" && method === "GET") {
    json(res, 200, { status: canary.getStatus() })
    return true
  }

  // ---- settings -----------------------------------------------------------
  if (seg[0] === "settings" && method === "GET") {
    json(res, 200, { settings: config.load().settings })
    return true
  }

  if (seg[0] === "settings" && method === "PUT") {
    const body = await readJsonBody(req)
    try {
      config.update((cfg) => {
        cfg.settings = { ...cfg.settings, ...body }
      })
      revive.start() // Restart revive loop with updated settings (idempotent)
      canary.start() // Start/stop canary per canaryEnabled (idempotent)
      events.emit("settings", { action: "updated", settings: config.load().settings })
      json(res, 200, { settings: config.load().settings })
    } catch (e) {
      return error(res, 400, e.message), true
    }
    return true
  }

  // ---- quality evidence ----------------------------------------------------
  if (seg[0] === "quality" && seg[1] === "decisions" && method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)))
    json(res, 200, { decisions: store.recentDecisions(limit, url.searchParams.get("pool") || null) })
    return true
  }

  if (seg[0] === "quality" && seg[1] === "summary" && method === "GET") {
    const windowMs = Math.min(
      30 * 24 * 3600 * 1000,
      Math.max(60000, Number(url.searchParams.get("window")) || 24 * 3600 * 1000),
    )
    json(res, 200, {
      summary: store.qualitySummary({ poolId: url.searchParams.get("pool") || null, windowMs }),
      windowMs,
    })
    return true
  }

  // ---- live feed ----------------------------------------------------------
  if (seg[0] === "feed" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 60)
    json(res, 200, { feed: metrics.feed(limit, url.searchParams.get("pool") || null) })
    return true
  }

  return false
}

module.exports = { handle, poolView, providerView, keyView }
