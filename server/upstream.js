"use strict"
// DOC: ../docs/architecture.md → § Module map → server/upstream.js

// Outbound call to one (provider, key, model) combination.
//
// Two shapes:
//   callJson    non-streaming; returns the parsed body
//   openStream  returns { res } with the body still unread, so the router can
//               decide whether to commit before any bytes reach the client
//
// The critical property for failover: this module never writes to the client.
// It hands back a status and, for streams, an unconsumed body. The router alone
// decides whether an attempt is committed. Once bytes are flushed to the client,
// switching providers would corrupt the response, so that decision must be made
// exactly once and before the first byte.

const secrets = require("./secrets")
const quirks = require("./quirks")

// Fallbacks only. The router passes settings-derived values clamped to what is
// left of the request budget; these apply when upstream.js is called directly
// (revive probes, model listing, tests). See config.js § time budgets for how
// the numbers were chosen.
const DEFAULT_TIMEOUT_MS = 90000
const DEFAULT_CHUNK_TIMEOUT_MS = 60000
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 30000

function buildHeaders(provider, keyValue, applied, ctx) {
  const headers = {
    "content-type": "application/json",
    accept: ctx?.stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${keyValue}`,
  }
  return applied.headers(headers, ctx)
}

function joinUrl(baseURL, suffix) {
  return `${String(baseURL).replace(/\/+$/, "")}${suffix}`
}

async function readJson(res) {
  const text = await res.text()
  try {
    return { body: JSON.parse(text), raw: text }
  } catch {
    return { body: text, raw: text }
  }
}

/**
 * Non-streaming request.
 * @returns {Promise<{ok:boolean,status:number,body:any,latencyMs:number,error?:Error}>}
 */
async function callJson({ provider, keyId, model, payload, applied, signal, timeoutMs }) {
  const keyValue = secrets.get(keyId)
  if (!keyValue) {
    return { ok: false, status: 0, body: null, latencyMs: 0, error: new Error(`no stored value for key ${keyId}`) }
  }

  const ctx = { provider, model, stream: false, tools: payload.tools }
  const body = applied.request({ ...payload, model }, ctx)
  const headers = buildHeaders(provider, keyValue, applied, ctx)


  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const t0 = Date.now()
  try {
    const res = await fetch(joinUrl(provider.baseURL, "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const { body: parsed } = await readJson(res)
    const latencyMs = Date.now() - t0

    if (!res.ok) {
      return { ok: false, status: res.status, body: parsed, latencyMs }
    }

    // A quirk may reject a 200 whose payload is unusable (e.g. tool arguments
    // truncated mid-JSON). It throws with a cupbearerVerdict attached; treat that
    // as a leg failure so the router can fail over rather than passing the
    // broken body to the client.
    let rewritten
    try {
      rewritten = applied.response(parsed, ctx)
    } catch (e) {
      if (!e?.cupbearerVerdict) throw e
      return { ok: false, status: res.status, body: parsed, latencyMs, error: e }
    }
    return { ok: true, status: res.status, body: rewritten, latencyMs }
  } catch (error) {
    return { ok: false, status: 0, body: null, latencyMs: Date.now() - t0, error }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Streaming request. Resolves as soon as response headers arrive — the body is
 * untouched, so a non-2xx can still be classified and failed over without the
 * client seeing anything.
 *
 * @returns {Promise<{ok:boolean,status:number,res?:Response,body?:any,latencyMs:number,error?:Error,abort:Function}>}
 */
async function openStream({ provider, keyId, model, payload, applied, signal, timeoutMs }) {
  const keyValue = secrets.get(keyId)
  if (!keyValue) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      error: new Error(`no stored value for key ${keyId}`),
      abort: () => {},
    }
  }

  const ctx = { provider, model, stream: true, tools: payload.tools }
  const body = applied.request({ ...payload, model, stream: true }, ctx)
  const headers = buildHeaders(provider, keyValue, applied, ctx)

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener("abort", onAbort, { once: true })

  // Guards the wait for response headers. Every gateway measured here withholds
  // headers until it has the first chunk ready (time-to-first-byte lands within
  // 1ms of the headers), so in practice this is the real "is this provider alive"
  // gate — which is why it must not be generous. Stalls *after* the first byte
  // belong to the relay, and only those are past the commit point.
  const headerTimer = setTimeout(() => ctrl.abort(), timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const t0 = Date.now()
  try {
    const res = await fetch(joinUrl(provider.baseURL, "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(headerTimer)
    const latencyMs = Date.now() - t0

    if (!res.ok) {
      const { body: parsed } = await readJson(res)
      if (signal) signal.removeEventListener("abort", onAbort)
      return { ok: false, status: res.status, body: parsed, latencyMs, abort: () => ctrl.abort() }
    }

    // Some gateways answer a stream request with a plain JSON body. Detect it
    // here so the relay is not left waiting for SSE frames that never come.
    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("text/event-stream")) {
      const { body: parsed } = await readJson(res)
      if (signal) signal.removeEventListener("abort", onAbort)
      let rewritten
      try {
        rewritten = applied.response(parsed, ctx)
      } catch (e) {
        if (!e?.cupbearerVerdict) throw e
        return { ok: false, status: res.status, body: parsed, latencyMs, error: e, abort: () => ctrl.abort() }
      }
      return {
        ok: true,
        status: res.status,
        latencyMs,
        notStream: true,
        body: rewritten,
        abort: () => ctrl.abort(),
      }
    }

    return {
      ok: true,
      status: res.status,
      res,
      latencyMs,
      ctx,
      abort: () => ctrl.abort(),
      cleanup: () => {
        if (signal) signal.removeEventListener("abort", onAbort)
      },
    }
  } catch (error) {
    clearTimeout(headerTimer)
    if (signal) signal.removeEventListener("abort", onAbort)
    return { ok: false, status: 0, latencyMs: Date.now() - t0, error, abort: () => ctrl.abort() }
  }
}

// ---------------------------------------------------------------- model listing

async function listModels({ provider, keyId, timeoutMs = 30000 }) {
  const keyValue = secrets.get(keyId)
  if (!keyValue) return { ok: false, error: new Error(`no stored value for key ${keyId}`) }

  const applied = quirks.compose(provider.quirks || [])
  const headers = applied.headers(
    { accept: "application/json", authorization: `Bearer ${keyValue}` },
    { provider, stream: false },
  )

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(joinUrl(provider.baseURL, "/models"), { headers, signal: ctrl.signal })
    const { body } = await readJson(res)
    if (!res.ok) return { ok: false, status: res.status, body }
    const arr = Array.isArray(body) ? body : body?.data
    if (!Array.isArray(arr)) return { ok: false, status: res.status, body }
    return { ok: true, status: res.status, models: arr.map((m) => m?.id ?? m?.name).filter(Boolean) }
  } catch (error) {
    return { ok: false, status: 0, error }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  callJson,
  openStream,
  listModels,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
}
