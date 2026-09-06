"use strict"
// DOC: ../docs/quirks.md → § LLM-as-judge
//
// Optional LLM-as-judge. Off by default — the heuristics in evaluators.js are
// the default quality signal, and the $0 story stays honest because of that.
// When a pool's qualityGate.judge is set to { providerId, model }, that leg
// (ideally a free-tier model on the user's own keys) grades candidate
// responses on a simple 0-10 rubric.
//
// Judge failures are always non-fatal: a score of null means "no opinion",
// and the gate falls back to heuristics alone.

const config = require("../config")
const secrets = require("../secrets")
const quirks = require("../quirks")
const upstream = require("../upstream")

function buildPrompt({ payload, responseText }) {
  const lastUser = [...(payload?.messages || [])].reverse().find((m) => m?.role === "user")
  const task =
    typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "").slice(0, 4000)
  return [
    {
      role: "system",
      content:
        'You grade AI assistant responses. Reply with ONLY a JSON object: {"score": <0-10>, "reason": "<one short sentence>"}. 10 = a competent, complete answer to the user\'s request. Judge correctness, completeness, and whether it follows the request — not style.',
    },
    {
      role: "user",
      content: `Request:\n${String(task).slice(0, 4000)}\n\nResponse to grade:\n${(responseText || "").slice(0, 8000)}`,
    },
  ]
}

/**
 * @returns {Promise<{score:number|null, reason:string, raw?:string}>}
 *   score is 0..1, or null when the judge has no opinion.
 */
async function judge({ payload, responseText, judge: cfg, timeoutMs = 20000 }) {
  const provider = config.getProvider(cfg.providerId)
  if (!provider || provider.enabled === false) return { score: null, reason: "judge provider missing or disabled" }
  const key = (provider.keys || []).find((k) => secrets.has(k.id))
  if (!key) return { score: null, reason: "judge provider has no stored key" }

  const applied = quirks.compose(provider.quirks || [])
  const out = await upstream.callJson({
    provider,
    keyId: key.id,
    model: cfg.model,
    payload: {
      model: cfg.model,
      messages: buildPrompt({ payload, responseText }),
      max_tokens: 200,
      temperature: 0,
    },
    applied,
    timeoutMs,
  })
  if (!out.ok) return { score: null, reason: `judge call failed (${out.status || out.error?.message || "error"})` }

  const text = out.body?.choices?.[0]?.message?.content || ""
  const m = text.match(/"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/)
  if (!m) return { score: null, reason: "judge returned no score", raw: text.slice(0, 200) }
  const rm = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  return { score: Math.max(0, Math.min(1, Number(m[1]) / 10)), reason: rm ? JSON.parse(`"${rm[1]}"`) : "" }
}

module.exports = { judge, buildPrompt }
