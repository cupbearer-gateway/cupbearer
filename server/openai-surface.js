"use strict"
// DOC: ../docs/api.md → § OpenAI surface

// The OpenAI-compatible surface every client talks to. Client-agnostic by design:
// any tool that speaks chat completions arrives here as a plain HTTP request, and
// nothing below this line branches on who is calling.
//
//   GET  /v1/models             every pool, as a model
//   POST /v1/chat/completions   routed through the pool's legs
//
// A model id may be either a pool id ("opus-5") or an explicit
// "providerId/model" escape hatch for bypassing pool routing when debugging.

const config = require("./config")
const router = require("./router")
const { json, error, readJsonBody } = require("./http-util")

function listModels(res) {
  const cfg = config.load()
  const created = Math.floor(Date.now() / 1000)
  json(res, 200, {
    object: "list",
    data: cfg.pools.map((p) => ({
      id: p.id,
      object: "model",
      created,
      owned_by: "cupbearer",
      // Non-standard but harmless, and useful when inspecting by hand.
      cupbearer: { name: p.name, legs: p.legs.map((l) => `${l.providerId}/${l.model}`) },
    })),
  })
}

// Build a throwaway single-leg pool so "providerId/model" works without config.
function directPool(modelId) {
  const idx = modelId.indexOf("/")
  if (idx === -1) return null
  const providerId = modelId.slice(0, idx)
  const model = modelId.slice(idx + 1)
  const provider = config.getProvider(providerId)
  if (!provider) return null
  return {
    id: modelId,
    name: modelId,
    legs: [{ providerId, model }],
    keyStrategy: "round-robin",
    _direct: true,
  }
}

// One line per attempted leg: what was tried and why it did not work. Used for
// both "pool has nothing left" and "ran out of time", since in either case the
// per-leg reasons are what actually tell you which provider to go fix.
function describeAttempts(attempts) {
  return (attempts || [])
    .map((a) => {
      if (a.skipped) return `${a.provider}/${a.model}: skipped (${a.skipped})`
      return `${a.provider}/${a.model} [${a.keyId}]: ${a.reason}${a.message ? ` — ${a.message}` : ""}`
    })
    .join("; ")
}

async function chatCompletions(req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (e) {
    return error(res, 400, `invalid request body: ${e.message}`)
  }

  const modelId = payload.model
  if (!modelId) return error(res, 400, "missing required field: model")

  const pool = config.getPool(modelId) || directPool(modelId)
  if (!pool) {
    const known = config.load().pools.map((p) => p.id)
    return error(
      res,
      404,
      `unknown model "${modelId}". Known pools: ${known.length ? known.join(", ") : "(none configured yet)"}`,
      { known },
    )
  }

  const controller = new AbortController()
  // If the client hangs up (user pressed escape), stop paying for the upstream call.
  req.on("close", () => {
    if (!res.writableEnded) controller.abort()
  })

  let outcome
  try {
    outcome = await router.dispatch({ pool, payload, res, signal: controller.signal })
  } catch (e) {
    if (!res.headersSent) return error(res, 500, `cupbearer router failure: ${e.message}`)
    try {
      res.end()
    } catch {}
    return
  }

  if (outcome.committed || outcome.aborted) return

  if (outcome.requestError) {
    if (res.headersSent) return res.end()
    // A budget timeout says *when* we gave up but not *why* each leg did, and
    // that per-leg detail is the whole diagnostic value. Clients only surface the
    // message string, so fold it in there rather than leaving it in the body.
    const message =
      outcome.requestError.reason === "request_budget_exceeded"
        ? `${outcome.requestError.message}. ${describeAttempts(outcome.attempts) || "no legs configured"}`
        : outcome.requestError.message
    return error(res, outcome.status, message, {
      reason: outcome.requestError.reason,
      attempts: outcome.attempts,
    })
  }

  // Nothing worked. Report every leg and why, so the dashboard and the terminal
  // both show the real reason rather than a bare 503.
  if (res.headersSent) return res.end()
  const detail = describeAttempts(outcome.attempts)

  // Status choice matters more than it looks: clients decide whether to retry
  // from it, and they cannot see the per-leg detail. A 503 is classified
  // `server_error` / retryable by most agents, so they re-send the whole turn
  // and burn another full pass over an already-exhausted pool. When every leg
  // failed for a reason that will not change on a retry — no keys, disabled
  // providers, rejected credentials — say 502 instead: a genuine "this pool is
  // misconfigured", not "come back in a moment".
  const transient = new Set([
    "rate_limited",
    "concurrency_limit",
    "upstream_error",
    "upstream_timeout",
    "timeout",
    "connection_failed",
    "stream_failed",
    "first_byte_timeout",
    "unknown",
  ])
  const tried = (outcome.attempts || []).filter((a) => !a.skipped)
  const worthRetrying = tried.length > 0 && tried.some((a) => transient.has(a.reason))

  return error(
    res,
    worthRetrying ? 503 : 502,
    `pool "${pool.id}" has no working provider. ${detail || "no legs configured"}`,
    { attempts: outcome.attempts },
  )
}

module.exports = { listModels, chatCompletions }
