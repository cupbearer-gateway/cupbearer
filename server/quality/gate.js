"use strict"
// DOC: ../docs/quirks.md → § The quality gate
//
// The quality gate. The differentiator: a request is only served from (or
// downgraded to) a cheaper leg when quality measurably holds — and every
// decision is recorded as evidence in SQLite.
//
// Modes (pool.qualityGate.mode, falling back to settings.defaultQualityMode):
//   off     availability-only routing, exactly as gateways have always worked
//   shadow  serve immediately, evaluate after the fact, log the score —
//           zero latency cost, builds the evidence base
//   gate    on DOWNGRADES only: evaluate before commit; a fail is just another
//           pre-commit failover to a stronger leg. First-choice legs never wait.
//
// Scoring: heuristic evaluators (evaluators.js) average their applicable
// scores; a configured judge (judge.js) is averaged in at half weight when it
// has an opinion. A hardFail (broken JSON, empty response, looped output)
// zeroes the verdict.

const config = require("../config")
const store = require("../store")
const evaluators = require("./evaluators")
const judge = require("./judge")

function config0(pool) {
  const cfg = pool.qualityGate || {}
  const settings = config.load().settings || {}
  const mode = cfg.mode || settings.defaultQualityMode || "off"
  return {
    mode,
    threshold: typeof cfg.threshold === "number" ? cfg.threshold : 0.8,
    evaluators: Array.isArray(cfg.evaluators) ? cfg.evaluators : Object.keys(evaluators.EVALUATORS),
    judge: cfg.judge && cfg.judge.providerId && cfg.judge.model ? cfg.judge : null,
    maxDowngrades: typeof cfg.maxDowngrades === "number" ? cfg.maxDowngrades : 2,
  }
}

// Normalize a non-streaming response body into the evaluator context shape.
function responseFromJson(body) {
  const msg = body?.choices?.[0]?.message
  return {
    text: typeof msg?.content === "string" ? msg.content : "",
    toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : null,
    finishReason: body?.choices?.[0]?.finish_reason || null,
  }
}

/**
 * Evaluate a response and record the decision.
 * @param {object} opts
 * @param {object} opts.pool
 * @param {object} opts.ctx        { payload, profile, responseText, toolCalls, finishReason, provider, keyId, model, servedTier }
 * @param {boolean} opts.downgrade whether the serving leg is weaker than required
 * @param {boolean} [opts.log]     append the decision row (default true)
 * @returns {Promise<{active:boolean, mode:string, passed:boolean, score:number|null, threshold:number, breakdown:object[], judge:object|null, hardFail:object|null}>}
 */
async function evaluate({ pool, ctx, downgrade, log = true }) {
  const gc = config0(pool)
  if (gc.mode === "off") return { active: false, mode: "off", passed: true, score: null, threshold: gc.threshold, breakdown: [], judge: null, hardFail: null }

  const result = evaluators.evaluate(ctx, gc.evaluators)
  let score = result.score
  let judgeResult = null
  if (gc.judge && (ctx.responseText || "").trim()) {
    const settings = config.load().settings || {}
    judgeResult = await judge
      .judge({ payload: ctx.payload, responseText: ctx.responseText, judge: gc.judge, timeoutMs: settings.gateTimeoutMs || 20000 })
      .catch((e) => ({ score: null, reason: e.message }))
    if (typeof judgeResult.score === "number") {
      // Heuristics catch mechanical breakage; the judge grades usefulness.
      // Each carries half the weight when both have opinions.
      score = result.evaluated ? (result.score + judgeResult.score) / 2 : judgeResult.score
    }
  }

  const passed = score >= gc.threshold
  if (log) {
    store.appendDecision({
      poolId: pool.id,
      kind: "gate",
      mode: gc.mode,
      providerId: ctx.provider,
      model: ctx.model,
      requiredTier: ctx.profile?.requiredTier ?? null,
      servedTier: ctx.servedTier ?? null,
      downgrade: Boolean(downgrade),
      score,
      threshold: gc.threshold,
      passed,
      breakdownJson: JSON.stringify(result.breakdown),
      judgeJson: judgeResult ? JSON.stringify(judgeResult) : null,
      detail: result.hardFail?.reason || (passed ? null : judgeResult?.reason || null),
    })
  }

  return { active: true, mode: gc.mode, passed, score, threshold: gc.threshold, breakdown: result.breakdown, judge: judgeResult, hardFail: result.hardFail }
}

module.exports = { config: config0, evaluate, responseFromJson }
