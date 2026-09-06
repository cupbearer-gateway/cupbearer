// Thin API client. Every call returns parsed JSON and throws an Error carrying
// the server's own message, so callers can surface real reasons rather than
// "something went wrong".

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: { message: text.slice(0, 400) } }
    }
  }

  if (!res.ok) {
    const err = new Error(payload?.error?.message || `HTTP ${res.status}`)
    err.status = res.status
    err.payload = payload
    throw err
  }
  return payload
}

export const api = {
  overview: () => request("/api/overview"),

  poolDetail: (id) => request(`/api/pools/${encodeURIComponent(id)}/detail`),
  createPool: (pool) => request("/api/pools", { method: "POST", body: pool }),
  updatePool: (id, patch) => request(`/api/pools/${encodeURIComponent(id)}`, { method: "PUT", body: patch }),
  deletePool: (id) => request(`/api/pools/${encodeURIComponent(id)}`, { method: "DELETE" }),

  createProvider: (p) => request("/api/providers", { method: "POST", body: p }),
  updateProvider: (id, patch) => request(`/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body: patch }),
  deleteProvider: (id, force = false) =>
    request(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE", body: { force } }),
  discoverModels: (id) => request(`/api/providers/${encodeURIComponent(id)}/discover`, { method: "POST" }),

  addKey: (providerId, key) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys`, { method: "POST", body: key }),
  updateKey: (providerId, keyId, patch) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`, {
      method: "PUT",
      body: patch,
    }),
  deleteKey: (providerId, keyId) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
    }),
  testKey: (providerId, keyId, model) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/test`, {
      method: "POST",
      body: model ? { model } : {},
    }),
  clearKey: (providerId, keyId) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/clear`, {
      method: "POST",
    }),
  getKeyValue: (providerId, keyId) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/value`, {
      method: "GET",
    }),

  bulkAddKeys: (providerId, keys, skipDuplicates = true) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/bulk`, {
      method: "POST",
      body: { keys, skipDuplicates },
    }),

  getSettings: () => request("/api/settings"),
  updateSettings: (patch) => request("/api/settings", { method: "PUT", body: patch }),

  qualityDecisions: (limit = 100, pool = null) =>
    request(`/api/quality/decisions?limit=${limit}${pool ? `&pool=${encodeURIComponent(pool)}` : ""}`),
  qualitySummary: (windowMs = 24 * 3600 * 1000, pool = null) =>
    request(`/api/quality/summary?window=${windowMs}${pool ? `&pool=${encodeURIComponent(pool)}` : ""}`),

  runRevive: () => request("/api/revive/run", { method: "POST" }),
  runCanary: () => request("/api/canary/run", { method: "POST" }),
  getCanaryStatus: () => request("/api/canary/status"),

  // Clear every sticky key + reset rotation so providers are tried from the top.
  restartRotation: () => request("/api/rotation/restart", { method: "POST" }),
}

/**
 * Subscribe to the server's SSE stream.
 * @param {(type: string, data: any) => void} onEvent
 * @returns {() => void} unsubscribe
 */
export function subscribeEvents(onEvent) {
  const source = new EventSource("/api/events")
  const types = ["attempt", "success", "failure", "gate", "pools", "providers"]
  const handlers = types.map((type) => {
    const h = (e) => {
      let data = null
      try {
        data = JSON.parse(e.data)
      } catch {}
      onEvent(type, data)
    }
    source.addEventListener(type, h)
    return [type, h]
  })
  return () => {
    for (const [type, h] of handlers) source.removeEventListener(type, h)
    source.close()
  }
}
