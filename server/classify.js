"use strict"
// DOC: ../docs/architecture.md → § Module map → server/classify.js

// Error classification: upstream failure -> what it means for the key, and
// whether the router should try somewhere else.
//
// Every pattern here was observed during Phase 0 probing against the real
// gateways, not guessed. Sources noted per rule.
//
// Outcome shape:
//   {
//     reason:     short machine token, shown in the dashboard
//     keyState:   healthy | cooling | exhausted | auth_failed | degraded | dead
//     scope:      "key"      -> other keys on this provider may work
//                 "leg"      -> every key on this leg will fail the same way
//                               (e.g. the model itself is unavailable here)
//                 "request"  -> our request is malformed; failing over is
//                               pointless and would just burn quota. Two
//                               exceptions the router handles rather than this
//                               module: `bad_request` (a guess, not a diagnosis)
//                               and `context_too_long` (windows differ per
//                               deployment) may each try another provider — see
//                               router.RETRY_ON_ANOTHER_LEG and architecture.md
//                               § Ambiguous 400s.
//     retry:      may the router try the next key/leg?
//     message:    human-readable, verbatim from upstream where possible
//   }

// Most gateways here are new-api forks; they append "(request id: ...)" to
// every message. Strip it so the dashboard shows a stable, readable error.
function cleanMessage(msg) {
  return String(msg || "")
    .replace(/\s*\(request id:\s*[^)]*\)/gi, "")
    .trim()
}

function extractMessage(body) {
  if (!body) return ""
  if (typeof body === "string") return body
  return (
    body?.error?.message ??
    body?.message ??
    body?.error?.code ??
    body?.detail ??
    (typeof body === "object" ? JSON.stringify(body).slice(0, 400) : String(body))
  )
}

// ---------------------------------------------------------------------- rules
//
// Ordered. First match wins, so put specific patterns above general ones.

const RULES = [
  // --- upstream quota / budget refusals -------------------------------------
  //
  // These say "nothing left to spend on THIS model route", whatever the
  // upstream's unit of account is. Observed reality (agentrouter, tabitoken):
  // the refusal is specific to the model's channel or budget pool — the same
  // key keeps answering 200 for its other models. So quota verdicts are
  // leg-scoped: the router pulls the failing model on this provider and moves
  // on, while the key stays in rotation for everything else. Health tracks the
  // per-(key, model) pull, not the key globally.
  {
    // agentrouter, observed: 402 "Budget pool quota has been exhausted."
    // Observed at agentrouter: a 402 for ONE model while the same key kept
    // answering 200 for every other model it serves. The budget pool is tied to
    // the model's channel, not the credential, so this is leg-scoped: only the
    // failing model is pulled, the key stays in rotation for the rest.
    test: (s) => /budget pool quota has been exhausted/i.test(s),
    reason: "budget_exhausted",
    keyState: "exhausted",
    scope: "leg",
  },
  {
    // Same per-model budget reality as budget_exhausted: the wallet being empty
    // for one model route must not pull the key from every pool it serves.
    test: (s) =>
      /insufficient (?:balance|credit|quota|funds)/i.test(s) ||
      /quota (?:exceeded|exhausted)/i.test(s) ||
      /(?:balance|credit)s? (?:is |are )?(?:too low|depleted|exhausted|insufficient)/i.test(s) ||
      /余额不足/.test(s) || // "insufficient balance"
      /额度(?:不足|已用完)/.test(s), // "quota insufficient / used up"
    reason: "credit_exhausted",
    keyState: "exhausted",
    scope: "leg",
  },
  {
    // tabitoken, observed as a 403: "预扣费额度失败, 用户剩余额度: ＄0.401526,
    // 需要预扣费额度: ＄0.800000" — the pre-authorisation hold failed because the
    // remaining balance is smaller than the request's estimated cost. The bare
    // 403 fallback called this a rejected key, which is wrong: the credential is
    // fine, the wallet is empty. Marking it `exhausted` is what lets a top-up be
    // picked up by the revive probe instead of looking like a revoked key.
    test: (s) =>
      /预扣费额度失败/.test(s) || // "pre-charge quota hold failed"
      /用户剩余额度/.test(s) || // "user remaining quota: $x"
      /pre-?(?:charge|deduct|authorization) .*(?:failed|insufficient)/i.test(s),
    reason: "credit_exhausted",
    keyState: "exhausted",
    scope: "leg",
  },

  // --- auth -----------------------------------------------------------------
  {
    // kktoken + gorouter, observed: 401 {"message":"Invalid token", type:new_api_error}
    test: (s) =>
      /invalid token/i.test(s) ||
      /invalid api[- ]?key/i.test(s) ||
      /unauthorized, invalid access token/i.test(s) ||
      /incorrect api key/i.test(s) ||
      /令牌无效/.test(s),
    reason: "invalid_key",
    keyState: "auth_failed",
    scope: "key",
  },
  {
    // true-sota, observed: 403 GROUP_DISABLED "API Key 所属分组已停用"
    test: (s) => /group_disabled/i.test(s) || /所属分组已停用/.test(s),
    reason: "group_disabled",
    keyState: "auth_failed",
    scope: "key",
  },
  {
    // agentrouter WAF, observed: 401 "unauthorized client detected".
    // Not the key's fault — our request lacked the required client headers.
    // Signals a Cupbearer bug (missing waf-headers quirk), so do not blame the key.
    test: (s) => /unauthorized client detected/i.test(s),
    reason: "client_rejected",
    keyState: "degraded",
    scope: "leg",
  },

  // --- rate limiting --------------------------------------------------------
  {
    // seekai, observed: 429 "Concurrency limit exceeded for user, please retry later"
    test: (s) => /concurrency limit exceeded/i.test(s),
    reason: "concurrency_limit",
    keyState: "cooling",
    scope: "key",
  },
  {
    // NVIDIA NIM, observed both ways for the same cause — as an error object
    // inside a 200 SSE stream, and as a plain 503:
    //   "ResourceExhausted: Worker local total request limit reached (16/16)"
    // OpenRouter relays it verbatim with an "Upstream error from Nvidia: " prefix.
    // It is the free tier's per-account concurrency cap: 6 parallel calls
    // produced one of these and five successes, and the same key works again
    // immediately. Must be cooling, not degraded — degraded counts toward
    // errorPullAfterFailures and would mark a perfectly good key dead after
    // three bursts.
    test: (s) => /resourceexhausted/i.test(s) || /worker local total request limit reached/i.test(s),
    reason: "concurrency_limit",
    keyState: "cooling",
    scope: "key",
  },
  {
    test: (s) => /rate limit/i.test(s) || /too many requests/i.test(s) || /请求过于频繁/.test(s),
    reason: "rate_limited",
    keyState: "cooling",
    scope: "key",
  },
  {
    // hcnapi, observed: "The request queue is full." The upstream is saturated
    // right now — every key there sees it and it clears on its own. Without a
    // rule this fell through to `unknown`, and three of those in a row pulled the
    // key as *dead*, so a busy provider looked permanently broken. Cool the key
    // and move on instead.
    test: (s) =>
      /request queue is full/i.test(s) ||
      /queue is full/i.test(s) ||
      /server is busy/i.test(s) ||
      /overloaded/i.test(s) ||
      /系统繁忙/.test(s),
    reason: "provider_busy",
    keyState: "cooling",
    scope: "key",
  },

  // --- model unavailable at this provider -----------------------------------
  {
    // seekai + agentrouter, observed: 503
    //   "No available channel for model X under group default (distributor)"
    //   "当前分组 default 下对于模型 X 无可用渠道"
    // Every key on this provider hits the same wall, so skip the whole leg.
    test: (s) => /no available channel/i.test(s) || /无可用渠道/.test(s),
    reason: "no_channel",
    keyState: "healthy",
    scope: "leg",
  },
  {
    // NVIDIA NIM, observed: 410 "The model 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1'
    // has reached its end of life on 2026-08-26T09:00:00Z and is no longer
    // available." The model is gone for everyone — not the key's fault, and no
    // other key will do better, so retire the leg.
    test: (s) => /reached its end of life/i.test(s) || /no longer available/i.test(s),
    reason: "model_retired",
    keyState: "healthy",
    scope: "leg",
  },
  {
    // OpenRouter, observed: 403 "thinkingmachines/inkling:free is only available
    // on agentic harnesses." Gating is on the MODEL, not the credential, so this
    // must not reach the 403 → auth_failed fallback below: that is sticky and
    // would pull a working key out of every pool it serves.
    test: (s) => /only available on agentic harnesses/i.test(s),
    reason: "model_gated",
    keyState: "healthy",
    scope: "leg",
  },
  {
    test: (s) =>
      /model .*(?:not found|does not exist|is not available|unsupported)/i.test(s) ||
      /(?:unknown|invalid) model/i.test(s) ||
      /模型不存在/.test(s),
    reason: "model_unavailable",
    keyState: "healthy",
    scope: "leg",
  },

  {
    // vyce, observed in-stream after a 200: {"error":{"type":"server_error",
    // "code":"internal_error","message":"An internal error occurred..."}}.
    // Also returned as a 500 for the same prompts. Degraded, not dead — the
    // provider works for smaller requests. It is also per-model (vyce serves
    // several models; only deepseek-v4-flash errors like this), so the degraded
    // streak counts per (key, model) and cannot pull the key's other models.
    test: (s) => /an internal error occurred/i.test(s) || /"code":\s*"internal_error"/i.test(s),
    reason: "upstream_error",
    keyState: "degraded",
    scope: "leg",
  },

  // --- our fault (mostly) ---------------------------------------------------
  {
    // Context windows are per-DEPLOYMENT, not per-model: probed directly, vyce
    // caps deepseek-v4-flash at 128k while gonkarouter and agentrouter serve the
    // same model with more. So this is request-scoped (no point retrying the same
    // key) but the router is allowed to try another provider — see
    // router.RETRY_ON_ANOTHER_LEG.
    test: (s) => /context length|maximum context|too many tokens|token limit/i.test(s),
    reason: "context_too_long",
    keyState: "healthy",
    scope: "request",
  },
  {
    test: (s) => /content (?:filter|policy)|safety|flagged/i.test(s),
    reason: "content_filtered",
    keyState: "healthy",
    scope: "request",
  },
]

// -------------------------------------------------------------------- statuses

function fromStatus(status) {
  if (status === 402) return { reason: "payment_required", keyState: "exhausted", scope: "leg" }
  if (status === 401) return { reason: "unauthorized", keyState: "auth_failed", scope: "key" }
  if (status === 403) return { reason: "forbidden", keyState: "auth_failed", scope: "key" }
  if (status === 429) return { reason: "rate_limited", keyState: "cooling", scope: "key" }
  if (status === 404) return { reason: "not_found", keyState: "healthy", scope: "leg" }
  if (status === 408) return { reason: "upstream_timeout", keyState: "degraded", scope: "leg" }
  // 5xx: degraded and leg-scoped. Whether the provider's whole fleet is down or
  // just this model's backend, the other keys see the same thing (no point
  // trying them) and per-model scoping means other models on the same key keep
  // working. A genuinely dead provider converges: every model gets its own
  // streak and the leg is pulled anyway.
  if (status >= 500) return { reason: "upstream_error", keyState: "degraded", scope: "leg" }
  if (status === 400) {
    // Ambiguous: gateways use 400 both for bad requests and for billing issues.
    // Message rules above get first crack; this is the fallback. Because it is a
    // guess rather than a diagnosis, the router treats this one reason as
    // failover-eligible on a multi-provider pool (router.mayTryAnotherLeg).
    return { reason: "bad_request", keyState: "healthy", scope: "request" }
  }
  // Anything else in the 4xx range is a protocol or routing mismatch — the wrong
  // path, verb, or content type for THIS gateway. Observed: agentrouter answering
  // 405 four times. It says nothing about the credential, so the key must stay
  // healthy: `degraded` counts toward errorPullAfterFailures and would have
  // killed a working key after three of them. Leg-scoped, because every key on
  // this provider will hit the same mismatch.
  if (status >= 400) return { reason: `http_${status}`, keyState: "healthy", scope: "leg" }
  return null
}

/**
 * @param {object} input
 * @param {number} [input.status]  HTTP status, 0/undefined for transport errors
 * @param {any}    [input.body]    parsed JSON or raw text
 * @param {Error}  [input.error]   transport-level failure
 */
function classify({ status, body, error } = {}) {
  // A quirk rejected an otherwise-2xx response and told us exactly why (e.g.
  // tool arguments truncated mid-JSON). It has more context than any pattern
  // match could, so take its word for it.
  if (error?.cupbearerVerdict) {
    return {
      retry: true,
      ...error.cupbearerVerdict,
      message: error.message || error.cupbearerVerdict.reason,
    }
  }

  // Transport failure: never reached the app, so the key tells us nothing.
  if (error && !status) {
    const m = String(error.message || error)
    const aborted = /abort/i.test(m) || error.name === "AbortError"
    return {
      reason: aborted ? "timeout" : "connection_failed",
      keyState: "degraded",
      scope: "key",
      retry: true,
      message: aborted ? "Request timed out" : `Connection failed: ${m}`,
    }
  }

  const rawMessage = cleanMessage(extractMessage(body))
  const haystack = `${rawMessage} ${typeof body === "string" ? "" : JSON.stringify(body ?? "")}`

  for (const rule of RULES) {
    if (rule.test(haystack)) {
      return {
        reason: rule.reason,
        keyState: rule.keyState,
        scope: rule.scope,
        retry: rule.scope !== "request",
        message: rawMessage || rule.reason,
      }
    }
  }

  const byStatus = fromStatus(status)
  if (byStatus) {
    return {
      ...byStatus,
      retry: byStatus.scope !== "request",
      message: rawMessage || `HTTP ${status}`,
    }
  }

  return {
    reason: "unknown",
    keyState: "degraded",
    scope: "key",
    retry: true,
    message: rawMessage || `HTTP ${status ?? "?"}`,
  }
}

module.exports = { classify, cleanMessage, extractMessage }
