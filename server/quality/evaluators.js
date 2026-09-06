"use strict"
// DOC: ../docs/quirks.md → § Quality evaluators
//
// Heuristic quality evaluators: $0, synchronous signals that a response is
// usable for the request it answers. They are not a quality oracle — they catch
// the mechanical failure modes that make a downgrade worthless:
// broken JSON, empty replies, refusal openings, looping output, truncated
// generation, malformed tool calls.
//
// Contract: each evaluator gets a context and returns
//   { applies: false }                                  — not relevant here
//   { applies: true, score: 0..1, reason?, hardFail? }  — hardFail zeroes the
//     whole verdict (a response with invalid JSON is unusable no matter what
//     else is good about it).

const REFUSAL_PATTERNS = [
  // "I'm sorry, but I can't…" — an apology wired to a refusal, not to empathy
  // ("I'm sorry to hear that" must not match).
  /^i('|’|`)?(m| am)\s+(really\s+|very\s+|so\s+)?sorry\b.{0,30}\b(cannot|can't|can’t|won't|won’t)\b/i,
  /^(sorry|apologies)\b.{0,40}\bi\s+(cannot|can't|can’t|won't|won’t)\b/i,
  /^i\s+(cannot|can't|can’t|won't|won’t)\s+(help|assist|comply|fulfill|provide|create|write|generate|do|perform|share|reveal|answer|complete)\b/i,
  /\bi\s+(cannot|can't|can’t)\s+(help|assist|comply|fulfill|provide|create|write|generate)\b/i,
  /\bi\s+(won't|won’t)\s+(help|assist|provide)\b/i,
  /against my (principles|programming|guidelines|ethics)/i,
  /as an ai( language model| assistant)?,? i (cannot|can't|can’t)\b/i,
]

// Applies when the request asked for JSON output. A downgrade that breaks the
// client's parser is the worst kind of downgrade — silent downstream breakage.
function evalJson(ctx) {
  const fmt = ctx.payload?.response_format
  const wantsJson = fmt?.type === "json_object" || fmt === "json" || fmt?.type === "json_schema"
  if (!wantsJson) return { applies: false }
  const text = (ctx.responseText || "").trim()
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
  try {
    JSON.parse(stripped)
    return { applies: true, score: 1, reason: "valid JSON" }
  } catch {
    return { applies: true, score: 0, hardFail: true, reason: "response is not valid JSON" }
  }
}

function evalEmpty(ctx) {
  const hasText = (ctx.responseText || "").trim().length > 0
  if (hasText || ctx.sawToolCalls || (ctx.toolCalls && ctx.toolCalls.length)) {
    return { applies: true, score: 1, reason: "non-empty" }
  }
  return { applies: true, score: 0, hardFail: true, reason: "empty response" }
}

// A refusal from a cheap model on a prompt the stronger leg would answer is a
// quality drop — but it is scored, not hard-failed, because some refusals are
// legitimate answers to the prompt itself.
function evalRefusal(ctx) {
  const text = (ctx.responseText || "").trim()
  if (!text) return { applies: false }
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(text)) return { applies: true, score: 0, reason: "refusal-style opening" }
  }
  return { applies: true, score: 1 }
}

// Classic small-model collapse: the same output over and over.
function evalRepetition(ctx) {
  const text = ctx.responseText || ""
  if (text.length < 200) return { applies: false }
  const lines = text.split(/\n/).filter((l) => l.trim().length > 12)
  let run = 1
  let worst = 1
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1
    if (run > worst) worst = run
  }
  if (worst >= 4) return { applies: true, score: 0, hardFail: true, reason: `identical line repeated ${worst}x` }
  const tail = text.slice(-600)
  const chunk = tail.slice(-40).trim()
  if (chunk.length >= 20 && tail.split(chunk).length - 1 >= 3) {
    return { applies: true, score: 0, hardFail: true, reason: "output is looping" }
  }
  return { applies: true, score: 1 }
}

// Hitting the output cap is not fatal — the answer may be nearly complete —
// but it drags the score down rather than passing silently.
function evalTruncation(ctx) {
  if (ctx.finishReason !== "length") return { applies: false }
  return { applies: true, score: 0.5, reason: "hit the output cap (finish_reason=length)" }
}

// Tool requests: arguments must parse. Plain-text answers to a tools request
// are legal (models may decline to call a tool), so absence is not a failure.
function evalToolArgs(ctx) {
  if (!ctx.profile?.hasTools) return { applies: false }
  const calls = ctx.toolCalls || []
  if (!calls.length) return { applies: false }
  for (const c of calls) {
    const args = c?.function?.arguments
    if (typeof args === "string" && args.length) {
      try {
        JSON.parse(args)
      } catch {
        return { applies: true, score: 0, hardFail: true, reason: "tool call arguments are not valid JSON" }
      }
    }
  }
  return { applies: true, score: 1 }
}

const EVALUATORS = {
  json: evalJson,
  empty: evalEmpty,
  refusal: evalRefusal,
  repetition: evalRepetition,
  truncation: evalTruncation,
  "tool-args": evalToolArgs,
}

/**
 * Run the named evaluators over a response context.
 * @returns {{score:number, hardFail:object|null, breakdown:object[], evaluated:number}}
 */
function evaluate(ctx, names = Object.keys(EVALUATORS)) {
  const breakdown = []
  let hardFail = null
  let sum = 0
  let n = 0
  for (const name of names) {
    const fn = EVALUATORS[name]
    if (!fn) continue
    let r
    try {
      r = fn(ctx)
    } catch {
      continue // a buggy evaluator must never fail the request
    }
    if (!r || !r.applies) continue
    breakdown.push({ id: name, score: r.score, reason: r.reason || "" })
    if (r.hardFail && !hardFail) hardFail = { id: name, reason: r.reason }
    sum += r.score
    n++
  }
  return { score: hardFail ? 0 : n ? sum / n : 1, hardFail, breakdown, evaluated: n }
}

module.exports = { EVALUATORS, evaluate, _internals: { REFUSAL_PATTERNS } }
