"use strict"
// DOC: ../docs/architecture.md → § Module map → server/router.js · § Request lifecycle

// The router: resolve a pool, walk its legs in priority order, walk each
// provider's keys, and commit to the first attempt that produces a response.
//
// Failover contract
// -----------------
// An attempt may only be abandoned before any byte reaches the client. Once
// output is flushed, switching providers would splice two different responses
// together, so at that point a failure is reported rather than retried. In
// practice this loses very little: billing (402), auth (401), rate limits (429)
// and "no channel" (503) all arrive as a status code before any content.
//
// Scope from classify() drives how far we skip:
//   key      -> try the next key on this provider
//   leg      -> every key here fails identically; skip to the next provider
//   request  -> our payload is the problem; stop and surface it
//
// Key ordering is round-robin per provider so load spreads across keys instead
// of hammering the first one until it dies.

const config = require("./config")
const secrets = require("./secrets")
const health = require("./health")
const metrics = require("./metrics")
const events = require("./events")
const quirks = require("./quirks")
const upstream = require("./upstream")
const { relay } = require("./relay")
const { classify } = require("./classify")
const { profileRequest } = require("./profile")

// Tier-aware routing reads what the request needs (profile.js) before any
// upstream is contacted. A bug here must never take down routing: the plan
// just falls back to the pool's declared leg order.
function safeProfile(payload) {
  try {
    return profileRequest(payload)
  } catch {
    return null
  }
}

// providerId -> rotation cursor
const cursors = new Map()

function keyScore(keyId) {
  const snap = health.snapshot(keyId)
  const calls = snap.calls || 0
  const successRate = snap.successRate ?? 1
  const p50 = snap.p50Ms ?? 2000
  const statePenalty = snap.state === "degraded" ? 5000 : 0
  if (calls < 2) return 1500 // Untested keys sit comfortably in middle
  return (p50 / Math.max(0.1, successRate)) + statePenalty
}

function orderedKeys(provider, strategy) {
  const allKeys = (provider.keys || []).map((k) => k.id).filter((id) => secrets.has(id))
  const usable = allKeys.filter((id) => health.isUsable(id))
  if (usable.length <= 1) return usable

  const maxKeys = config.load().settings.maxKeysPerLeg || 8

  if (strategy === "fastest-first" || strategy === "quality") {
    const scored = usable.map((id) => ({ id, score: keyScore(id) }))
    scored.sort((a, b) => a.score - b.score)

    // Primary bucket: keys within 30% score of best key
    const bestScore = scored[0].score
    const cutoff = bestScore * 1.3
    const primary = scored.filter((k) => k.score <= cutoff).map((k) => k.id)
    const reserve = scored.filter((k) => k.score > cutoff).map((k) => k.id)

    const start = (cursors.get(provider.id) ?? 0) % primary.length
    cursors.set(provider.id, (start + 1) % primary.length)

    const primaryOrdered = primary.slice(start).concat(primary.slice(0, start))
    return primaryOrdered.concat(reserve).slice(0, maxKeys)
  }

  if (strategy === "sticky-until-error") {
    const start = cursors.get(provider.id) ?? 0
    return usable.slice(start % usable.length).concat(usable.slice(0, start % usable.length)).slice(0, maxKeys)
  }

  // round-robin (default)
  const start = (cursors.get(provider.id) ?? 0) % usable.length
  cursors.set(provider.id, (start + 1) % usable.length)
  return usable.slice(start).concat(usable.slice(0, start)).slice(0, maxKeys)
}

function advanceCursor(provider) {
  const usableCount = (provider.keys || []).filter((k) => secrets.has(k.id) && health.isUsable(k.id)).length || 1
  cursors.set(provider.id, ((cursors.get(provider.id) ?? 0) + 1) % usableCount)
}

// Forget every round-robin cursor so the next request starts from the first key
// on each provider. Called on pool edits and the manual rotation restart.
function resetCursors() {
  cursors.clear()
}

// Legs a request may use, best-fit first. With no tiers declared anywhere this
// is exactly the declared order — tiered routing only reorders when tiers exist.
// Sufficient legs (tier number <= required, every capability present) come
// first, cheapest (highest tier number) before stronger ones; everything else
// keeps the declared order after them. `downgrade` marks legs whose tier is
// worse than the request requires — the quality gate's business (quality/gate.js).
const DEFAULT_LEG_TIER = 2

function orderLegs(pool, requirement) {
  const legs = pool.legs || []
  if (!requirement || !legs.length) return legs.map((leg) => ({ leg, downgrade: false }))
  const need = [...(requirement.capabilities || [])]
  const sufficient = []
  const fallback = []
  for (const leg of legs) {
    const tier = typeof leg.tier === "number" ? leg.tier : DEFAULT_LEG_TIER
    const missing = need.filter((c) => !(leg.capabilities || []).includes(c))
    if (!missing.length && tier <= requirement.requiredTier) sufficient.push({ leg, tier })
    else fallback.push({ leg, tier })
  }
  // Stable sort in V8: equal tiers keep the declared order.
  sufficient.sort((a, b) => b.tier - a.tier)
  return [...sufficient, ...fallback].map(({ leg, tier }) => ({ leg, downgrade: tier > requirement.requiredTier }))
}

function buildPlan(pool, requirement) {
  const plan = []
  for (const { leg, downgrade } of orderLegs(pool, requirement)) {
    const provider = config.getProvider(leg.providerId)
    if (!provider) {
      plan.push({ leg, provider: null, skip: "provider_missing", keys: [], downgrade })
      continue
    }
    if (!config.isProviderUsable(provider)) {
      plan.push({ leg, provider, skip: "provider_disabled", keys: [], downgrade })
      continue
    }
    const usableKeys = orderedKeys(provider, pool.keyStrategy)
    if (!usableKeys.length) {
      const hasSecrets = (provider.keys || []).some((k) => secrets.has(k.id))
      const skipReason = hasSecrets ? "all_keys_unusable" : "no_keys"
      plan.push({ leg, provider, skip: skipReason, keys: [], downgrade })
      continue
    }
    plan.push({ leg, provider, keys: usableKeys, downgrade })
  }
  return plan
}

function attemptLabel(providerId, keyId, model) {
  return `${providerId}/${model} (${keyId})`
}

// Failover notifications. We toast on ANY switch the router is forced to make —
// key → key on the same provider, key/leg → provider, and the whole pool going
// down — so whoever runs Cupbearer stays up to date on every provider change.
// Throttling lives in notify.js (per-source cooldown + a hard global gap); the
// router only decides *what happened* and lets notify decide *whether to shout*.

function providerLabel(id) {
  return config.getProvider(id)?.label || id
}

// Human phrase for a classifier reason token. Keep in step with the UI's
// REASON_LABEL in ui/src/format.js — this is the server-side copy for toasts.
const REASON_PHRASE = {
  budget_exhausted: "hit an upstream quota cap",
  credit_exhausted: "is out of quota",
  payment_required: "is out of quota",
  invalid_key: "has a rejected key",
  unauthorized: "is unauthorized",
  forbidden: "is forbidden",
  group_disabled: "has a disabled group",
  rate_limited: "is rate limited",
  provider_busy: "is busy (queue full)",
  concurrency_limit: "hit its concurrency limit",
  no_channel: "has no capacity for this model",
  model_unavailable: "doesn't have this model",
  model_retired: "no longer serves this model",
  model_gated: "restricts this model",
  upstream_timeout: "timed out",
  timeout: "timed out",
  upstream_error: "hit an upstream error",
  connection_failed: "couldn't be reached",
  stream_failed: "dropped the stream mid-response",
  first_byte_timeout: "accepted the request then sent nothing",
  request_budget_exceeded: "ran out of time",
  context_too_long: "rejected the prompt (too long)",
  content_filtered: "blocked by a content filter",
  bad_request: "rejected the request",
  not_found: "returned not found",
  truncated_tool_call: "returned a truncated tool call",
  unknown: "failed",
}
function reasonPhrase(reason) {
  return REASON_PHRASE[reason] || "failed"
}

// Dominant reason a provider's keys are all unusable, for legs that are skipped
// before any attempt because every key is already out of rotation.
function deadPhrase(providerId) {
  const provider = config.getProvider(providerId)
  const states = (provider?.keys || []).map((k) => health.snapshot(k.id)?.state)
  if (states.includes("exhausted")) return "is out of quota"
  if (states.includes("auth_failed")) return "has a rejected key"
  if (states.includes("dead")) return "is marked dead"
  if (states.includes("cooling")) return "is rate limited"
  return "has no usable keys"
}

// The next leg in the plan that is actually attemptable (has keys).
function nextLeg(plan, i) {
  for (let j = i + 1; j < plan.length; j++) {
    if (!plan[j].skip) return plan[j]
  }
  return null
}

// A request-scoped verdict normally ends the request: classify() has decided our
// payload is the problem, so spending another leg's quota on it is pointless.
//
// Two reasons are exceptions, because for both of them "the payload is the
// problem" turns out to be true only *for that provider*:
//
//   bad_request        The bare-400 fallback in classify(), reached when no
//                      message rule matched — the classifier is admitting it does
//                      not know why the gateway said no. Measured: vyce 400s
//                      requests gonkarouter answers 200 (78 single-attempt aborts
//                      in one day on deepseek-v4-flash).
//   context_too_long   Context windows are per-deployment, not per-model. Probed
//                      directly on the four deepseek-v4-flash legs: vyce caps at
//                      128k and rejects above it, while gonkarouter and
//                      agentrouter accept the same 130k prompt. 104 requests were
//                      aborted on this, 103 of them without trying a second leg.
//
// A prompt too big for *every* leg still fails — it just fails after asking, and
// the client gets the last leg's message. The verdicts that really are universal
// (content_filtered, and a quirk's truncated_tool_call, which is a deterministic
// output cap) stop immediately. A single-provider pool has no next leg, so it
// keeps failing fast either way.
const RETRY_ON_ANOTHER_LEG = new Set(["bad_request", "context_too_long"])

function mayTryAnotherLeg(verdict, plan, i) {
  if (verdict.retry) return false
  if (!RETRY_ON_ANOTHER_LEG.has(verdict.reason)) return false
  return Boolean(nextLeg(plan, i))
}

// The request's time budget. A pool or provider may widen or narrow it, but every
// attempt is bounded by whatever is left of the whole request, so a slow provider
// can no longer eat the budget the next leg needs.
//
// `minSliceMs` is the point where starting another attempt stops making sense:
// below it even a healthy provider (p50 first response ~5s across 3380 recorded
// calls) would not finish, so we would burn a key's quota to still fail. It is
// clamped to the budget itself so a deliberately tight budget still gets to make
// its attempts instead of refusing every one of them.
function timeBudget(pool) {
  const s = config.load().settings || {}
  const totalMs = pool?.requestBudgetMs ?? s.requestBudgetMs ?? 180000
  const attemptMs = pool?.attemptTimeoutMs ?? s.attemptTimeoutMs ?? upstream.DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  return {
    startedAt,
    totalMs,
    remaining: () => Math.max(0, totalMs - (Date.now() - startedAt)),
    spent: () => Date.now() - startedAt,
    minSliceMs: Math.min(5000, Math.floor(totalMs / 2)),
    // What this attempt may spend: its own ceiling, capped by the remainder.
    attemptSlice(provider) {
      const own = provider?.timeoutMs ?? attemptMs
      return Math.min(own, this.remaining())
    },
    // Same clamp for the two stream waits, so a stalled stream cannot run past
    // the deadline either.
    firstChunkSlice(provider) {
      const own = provider?.firstChunkTimeoutMs ?? s.firstChunkTimeoutMs ?? upstream.DEFAULT_FIRST_CHUNK_TIMEOUT_MS
      return Math.min(own, this.remaining())
    },
    chunkSlice(provider) {
      const own = provider?.chunkTimeoutMs ?? s.chunkTimeoutMs ?? upstream.DEFAULT_CHUNK_TIMEOUT_MS
      return Math.min(own, this.remaining())
    },
    exhausted() {
      return this.remaining() < this.minSliceMs
    },
  }
}

function emitFailover(pool, providerId, key, title, message) {
  events.emit("provider_failover", { poolId: pool.id, providerId, key, title, message })
}

// A key failed and the router is moving to another key on the same provider.
//
// Deliberately near-silent. Multiple keys per provider exist so rotation is
// invisible: a rate limit or a timeout means the key will be back shortly, and
// toasting it turns normal operation into a stream of notifications.
//
// The exception is a key that is GONE — revoked, or refused for quota. That is a
// lost asset, not a transient blip: the pool is permanently thinner and no other
// signal would tell you. Those are announced once (notify.js dedupes per key),
// with a count of what is left so the message is actionable.
const KEY_LOSS_STATES = new Set(["exhausted", "auth_failed"])

function usableKeyCount(provider) {
  return (provider.keys || []).filter((k) => secrets.has(k.id) && health.isUsable(k.id)).length
}

function notifyKeySwitch(pool, provider, keyId, verdict) {
  if (!KEY_LOSS_STATES.has(verdict.keyState)) return // transient: rotate quietly

  const label = (provider.keys || []).find((k) => k.id === keyId)?.label || keyId
  // This key is already marked, so the count reflects what remains.
  const left = usableKeyCount(provider)
  const remaining =
    left > 0
      ? `${left} key${left === 1 ? "" : "s"} still working on "${pool.name || pool.id}".`
      : `No keys left on "${providerLabel(provider.id)}" — "${pool.name || pool.id}" now depends on its other providers.`

  emitFailover(
    pool,
    provider.id,
    // Per-key identity: one toast per lost key, not per pool that noticed it.
    `keyloss:${provider.id}:${keyId}`,
    "Key out of action",
    `"${providerLabel(provider.id)}" — ${label} ${reasonPhrase(verdict.reason)}. ${remaining}`,
  )
}

// A leg is finished and the request moves to the next provider — or, with no
// usable leg left, the pool is down.
function notifyProviderFailover(pool, step, plan, i, fail) {
  const next = nextLeg(plan, i)
  const from = providerLabel(step.leg.providerId)
  if (next) {
    emitFailover(
      pool,
      step.leg.providerId,
      `${pool.id}:${step.leg.providerId}`,
      "Switched provider",
      `"${from}" ${reasonPhrase(fail.reason)} on "${pool.name || pool.id}" — switched to "${providerLabel(next.leg.providerId)}".`,
    )
  } else {
    emitFailover(
      pool,
      step.leg.providerId,
      `${pool.id}:all`,
      "Pool has no working provider",
      `"${pool.name || pool.id}" has no working provider — requests are failing.`,
    )
  }
}

// A leg was skipped because every key is already out of rotation (sticky). This
// is deterministic per request, so notify.js' cooldown is what stops it from
// toasting on every call — the user still keeps knowing the provider is down.
function notifySkippedLeg(pool, step, plan, i) {
  const next = nextLeg(plan, i)
  if (!next) return
  emitFailover(
    pool,
    step.leg.providerId,
    `${pool.id}:${step.leg.providerId}`,
    "Provider unavailable",
    `"${providerLabel(step.leg.providerId)}" ${deadPhrase(step.leg.providerId)} on "${pool.name || pool.id}" — using "${providerLabel(next.leg.providerId)}".`,
  )
}

/**
 * Execute a chat completion against a pool.
 *
 * @param {object} opts
 * @param {object} opts.pool
 * @param {object} opts.payload      OpenAI-shaped request body from the client
 * @param {import("http").ServerResponse} opts.res
 * @param {AbortSignal} [opts.signal]
 */
async function dispatch({ pool, payload, res, signal }) {
  const wantsStream = payload.stream === true
  // The direct providerId/model escape hatch means exactly what it says — no
  // profiling, no reordering. Everything else gets a tier requirement; a
  // profiling failure degrades to declared order rather than failing the request.
  const requirement = pool._direct ? null : safeProfile(payload)
  const plan = buildPlan(pool, requirement)
  const attempts = []
  let attemptCount = 0
  let triedLeg = false
  let sawUnusableSkip = false

  // One clock for the whole request. Without it the attempt chain is unbounded —
  // legs x keys, each free to wait out its own timeout — and the client just sees
  // a hang. Every attempt below is clamped to what is left, and once the
  // remainder is too small to be worth spending we stop instead of starting an
  // attempt we know cannot finish. See config.js § time budgets.
  const budget = timeBudget(pool)

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]
    let legFail = null
    if (step.skip) {
      attempts.push({ provider: step.leg.providerId, model: step.leg.model, skipped: step.skip })
      // Every key out of rotation: the provider is down, not just this leg.
      // Deterministic per request, so notify.js' cooldown stops the spam.
      if (step.skip === "all_keys_unusable") {
        sawUnusableSkip = true
        notifySkippedLeg(pool, step, plan, i)
      }
      continue
    }

    const { provider, leg } = step
    triedLeg = true
    let applied
    try {
      applied = quirks.compose(provider.quirks || [])
    } catch (e) {
      // Misconfigured quirk list: skip the leg rather than take down the request.
      attempts.push({ provider: provider.id, model: leg.model, skipped: "bad_quirks", message: e.message })
      continue
    }

    for (let ki = 0; ki < step.keys.length; ki++) {
      const keyId = step.keys[ki]
      if (signal?.aborted) return { aborted: true, attempts }

      // Out of time. Report it rather than starting an attempt that cannot land.
      // The first attempt always runs: a budget that permits zero attempts is a
      // misconfiguration, not an instruction to refuse the request.
      if (attemptCount > 0 && budget.exhausted()) {
        attempts.push({ provider: provider.id, model: leg.model, keyId, skipped: "out_of_time" })
        return {
          requestError: {
            reason: "request_budget_exceeded",
            keyState: "healthy",
            scope: "request",
            retry: false,
            message: `no provider answered within ${budget.totalMs}ms (tried ${attemptCount})`,
          },
          status: 504,
          attempts,
        }
      }

      attemptCount++
      const attemptStartedAt = Date.now()
      health.markUsed(keyId)
      events.emit("attempt", { poolId: pool.id, providerId: provider.id, keyId, model: leg.model, attempt: attemptCount })

      const common = {
        provider,
        keyId,
        model: leg.model,
        payload,
        applied,
        signal,
        timeoutMs: budget.attemptSlice(provider),
      }

      // ---------------------------------------------------------- streaming
      if (wantsStream) {
        const opened = await upstream.openStream(common)

        if (!opened.ok) {
          const verdict = classify({ status: opened.status, body: opened.body, error: opened.error })
          health.markFailure(keyId, verdict)
          metrics.record({
            poolId: pool.id,
            providerId: provider.id,
            keyId,
            model: leg.model,
            ok: false,
            latencyMs: opened.latencyMs,
            status: opened.status,
            reason: verdict.reason,
            message: verdict.message,
            attempts: attemptCount,
            streamed: true,
          })
          events.emit("failure", {
            poolId: pool.id,
            providerId: provider.id,
            keyId,
            model: leg.model,
            reason: verdict.reason,
            message: verdict.message,
            state: health.snapshot(keyId).state,
          })
          attempts.push({
            provider: provider.id,
            model: leg.model,
            keyId,
            status: opened.status,
            reason: verdict.reason,
            message: verdict.message,
          })

          if (!verdict.retry) {
            // An ambiguous 400 on a multi-provider pool gets one more leg;
            // everything else request-scoped stops here. See mayTryAnotherLeg.
            if (mayTryAnotherLeg(verdict, plan, i)) {
              legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
              break
            }
            return { requestError: verdict, status: opened.status || 400, attempts }
          }

          // A switch is happening. Another key on this provider → key toast;
          // otherwise the leg is done and we decide provider vs pool after it.
          if (verdict.scope === "key" && ki < step.keys.length - 1) {
            notifyKeySwitch(pool, provider, keyId, verdict)
          } else {
            legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
          }
          if (verdict.scope === "leg") break // next provider
          advanceCursor(provider)
          continue // next key
        }

        // Gateway answered a stream request with plain JSON. Serve it as-is.
        if (opened.notStream) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(opened.body))
          const usage = opened.body?.usage || {}
          health.markSuccess(keyId, {
            latencyMs: opened.latencyMs,
            tokensIn: usage.prompt_tokens || 0,
            tokensOut: usage.completion_tokens || 0,
          })
          metrics.record({
            poolId: pool.id,
            providerId: provider.id,
            keyId,
            model: leg.model,
            ok: true,
            latencyMs: opened.latencyMs,
            status: 200,
            tokensIn: usage.prompt_tokens || 0,
            tokensOut: usage.completion_tokens || 0,
            attempts: attemptCount,
            streamed: false,
          })
          return { committed: true, providerId: provider.id, keyId, attempts }
        }

        // Headers are deferred to the first byte. A translator that buffers tool
        // calls can only judge the response at end of stream, so committing here
        // would forfeit failover on a response we are about to reject.
        const commit = () => {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
            "x-cupbearer-provider": provider.id,
            "x-cupbearer-model": leg.model,
            "x-cupbearer-attempts": String(attemptCount),
          })
        }

        const result = await relay({
          upstream: opened.res,
          res,
          applied,
          ctx: opened.ctx,
          chunkTimeoutMs: budget.chunkSlice(provider),
          firstChunkTimeoutMs: budget.firstChunkSlice(provider),
          onFirstByte: commit,
        })
        opened.cleanup?.()

        // Nothing was flushed and the response is unusable. The client has seen
        // nothing, so this is still a normal pre-commit failure: retryable ones
        // fail over, and a "request"-scoped one stops with a readable reason.
        if (result.errored && !result.wrote) {
          const verdict = result.verdict
            ? { retry: true, scope: "leg", ...result.verdict, message: result.errorMessage || result.verdict.reason }
            : result.errorBody
              ? // An error object inside the stream: same shape as a non-2xx body,
                // so the normal classifier rules (credit, rate limits, …) apply.
                classify({ status: 0, body: result.errorBody })
              : {
                  // Never a single byte: the provider took the request and went
                  // quiet. Worth naming separately from a mid-response drop —
                  // it is the failure mode that used to read as a plain hang.
                  reason: result.sawUpstreamBytes ? "stream_failed" : "first_byte_timeout",
                  keyState: "degraded",
                  scope: "key",
                  retry: true,
                  message: result.errorMessage || "Upstream stream failed",
                }
          health.markFailure(keyId, verdict)
          metrics.record({
            poolId: pool.id,
            providerId: provider.id,
            keyId,
            model: leg.model,
            ok: false,
            // Time actually spent, not time to headers. Recording opened.latencyMs
            // here made stalls invisible: a 30s silence was filed as a 400ms call.
            latencyMs: Date.now() - attemptStartedAt,
            status: 200,
            reason: verdict.reason,
            message: verdict.message,
            attempts: attemptCount,
            streamed: true,
          })
          events.emit("failure", {
            poolId: pool.id,
            providerId: provider.id,
            keyId,
            model: leg.model,
            reason: verdict.reason,
            message: verdict.message,
            state: health.snapshot(keyId).state,
          })
          attempts.push({
            provider: provider.id,
            model: leg.model,
            keyId,
            status: 200,
            reason: verdict.reason,
            message: verdict.message,
          })

          if (!verdict.retry) {
            // Quirk verdicts land here too (truncated_tool_call is deliberately
            // request-scoped), so only an ambiguous 400 may take another leg.
            if (mayTryAnotherLeg(verdict, plan, i)) {
              legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
              break
            }
            return { requestError: verdict, status: verdict.status ?? 502, attempts }
          }
          if (verdict.scope === "key" && ki < step.keys.length - 1) {
            notifyKeySwitch(pool, provider, keyId, verdict)
          } else {
            legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
          }
          if (verdict.scope === "leg") break // next provider
          advanceCursor(provider)
          continue // next key
        }

        // Committed: bytes are on the wire, so this attempt is final either way.
        if (!result.wrote) commit()
        res.end()

        let streamVerdict = null
        if (result.errored) {
          // The relay may know exactly what went wrong (e.g. a translator
          // rejecting truncated tool arguments); prefer its verdict so health
          // and the dashboard record the real reason and the right scope.
          streamVerdict = result.verdict
            ? { ...result.verdict, message: result.errorMessage || result.verdict.reason }
            : { reason: "stream_failed", keyState: "degraded", message: "Upstream stream failed mid-response" }
          health.markFailure(keyId, streamVerdict)
          attempts.push({
            provider: provider.id,
            model: leg.model,
            keyId,
            status: 200,
            reason: streamVerdict.reason,
            message: streamVerdict.message,
          })
        } else {
          health.markSuccess(keyId, {
            latencyMs: opened.latencyMs,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
          })
        }
        metrics.record({
          poolId: pool.id,
          providerId: provider.id,
          keyId,
          model: leg.model,
          ok: !result.errored,
          latencyMs: opened.latencyMs,
          status: 200,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          reason: streamVerdict?.reason,
          message: streamVerdict?.message,
          attempts: attemptCount,
          streamed: true,
        })
        events.emit(result.errored ? "failure" : "success", {
          poolId: pool.id,
          providerId: provider.id,
          keyId,
          model: leg.model,
          latencyMs: opened.latencyMs,
          tokensOut: result.tokensOut,
        })
        return { committed: true, providerId: provider.id, keyId, attempts }
      }

      // ------------------------------------------------------ non-streaming
      const out = await upstream.callJson(common)

      if (!out.ok) {
        const verdict = classify({ status: out.status, body: out.body, error: out.error })
        health.markFailure(keyId, verdict)
        metrics.record({
          poolId: pool.id,
          providerId: provider.id,
          keyId,
          model: leg.model,
          ok: false,
          latencyMs: out.latencyMs,
          status: out.status,
          reason: verdict.reason,
          message: verdict.message,
          attempts: attemptCount,
          streamed: false,
        })
        events.emit("failure", {
          poolId: pool.id,
          providerId: provider.id,
          keyId,
          model: leg.model,
          reason: verdict.reason,
          message: verdict.message,
          state: health.snapshot(keyId).state,
        })
        attempts.push({
          provider: provider.id,
          model: leg.model,
          keyId,
          status: out.status,
          reason: verdict.reason,
          message: verdict.message,
        })

        if (!verdict.retry) {
          // Ambiguous 400 → one more provider; anything diagnosed stops here.
          if (mayTryAnotherLeg(verdict, plan, i)) {
            legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
            break
          }
          return { requestError: verdict, status: out.status || 400, attempts }
        }

        // A switch is happening. Another key on this provider → key toast;
        // otherwise the leg is done and we decide provider vs pool after it.
        if (verdict.scope === "key" && ki < step.keys.length - 1) {
          notifyKeySwitch(pool, provider, keyId, verdict)
        } else {
          legFail = { keyState: verdict.keyState, reason: verdict.reason, message: verdict.message, keyId }
        }
        if (verdict.scope === "leg") break
        advanceCursor(provider)
        continue
      }

      const usage = out.body?.usage || {}
      health.markSuccess(keyId, {
        latencyMs: out.latencyMs,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
      })
      metrics.record({
        poolId: pool.id,
        providerId: provider.id,
        keyId,
        model: leg.model,
        ok: true,
        latencyMs: out.latencyMs,
        status: 200,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        attempts: attemptCount,
        streamed: false,
      })
      events.emit("success", {
        poolId: pool.id,
        providerId: provider.id,
        keyId,
        model: leg.model,
        latencyMs: out.latencyMs,
        tokensOut: usage.completion_tokens || 0,
      })

      res.writeHead(200, {
        "content-type": "application/json",
        "x-cupbearer-provider": provider.id,
        "x-cupbearer-model": leg.model,
        "x-cupbearer-attempts": String(attemptCount),
      })
      // Report the pool id back as the model so the client sees what it asked for.
      res.end(JSON.stringify({ ...out.body, model: pool.id }))
      return { committed: true, providerId: provider.id, keyId, attempts }
    }

    // Leg finished. A failure on its last key (or a leg-wide failure) moves the
    // request to the next provider — toast that. Committed legs returned above.
    if (legFail) notifyProviderFailover(pool, step, plan, i, legFail)
  }

  // Every leg was skipped with all keys unusable and nothing was ever tried:
  // the pool itself is down. (If a real leg failed as the last one, the
  // provider-failover path already toasts this.)
  if (sawUnusableSkip && !triedLeg && plan.length) {
    emitFailover(
      pool,
      plan[0].leg.providerId,
      `${pool.id}:all`,
      "Pool has no working provider",
      `"${pool.name || pool.id}" has no working provider — requests are failing.`,
    )
  }

  return { exhausted: true, attempts }
}

module.exports = {
  dispatch,
  buildPlan,
  orderLegs,
  orderedKeys,
  resetCursors,
  // exported for tests: the notification policy is worth pinning independently
  // of a full dispatch, since it decides what interrupts the user.
  _internals: { notifyKeySwitch, notifyProviderFailover, notifySkippedLeg, usableKeyCount, safeProfile, DEFAULT_LEG_TIER },
}
