"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { evaluate, EVALUATORS } = require("./evaluators")

const base = { payload: {}, profile: { hasTools: false }, responseText: "A perfectly reasonable answer.", toolCalls: null, finishReason: "stop" }

test("a clean response scores 1 with no hard failures", () => {
  const r = evaluate(base)
  assert.equal(r.hardFail, null)
  assert.equal(r.score, 1)
})

test("empty response is a hard failure", () => {
  const r = evaluate({ ...base, responseText: "" })
  assert.equal(r.score, 0)
  assert.equal(r.hardFail.id, "empty")
})

test("invalid JSON is a hard failure when JSON was requested", () => {
  const payload = { response_format: { type: "json_object" } }
  const good = evaluate({ ...base, payload, responseText: '{"a": 1}' })
  assert.equal(good.score, 1)
  const bad = evaluate({ ...base, payload, responseText: "here you go: {a: 1" })
  assert.equal(bad.score, 0)
  assert.equal(bad.hardFail.id, "json")
})

test("JSON in code fences still parses", () => {
  const payload = { response_format: { type: "json_object" } }
  const r = evaluate({ ...base, payload, responseText: '```json\n{"ok": true}\n```' })
  assert.equal(r.score, 1)
})

test("refusal openings score 0 but do not hard-fail", () => {
  const r = evaluate({ ...base, responseText: "I'm sorry, but I cannot help with that." })
  // Refusal (0) averages with the non-empty check (1): a real drop, not zero.
  assert.equal(r.score, 0.5)
  assert.equal(r.hardFail, null)
  const entry = r.breakdown.find((b) => b.id === "refusal")
  assert.equal(entry.score, 0)
})

test("a normal answer is not a refusal", () => {
  const r = evaluate({ ...base, responseText: "I cannot recommend it enough — here is how it works: ..." })
  assert.equal(r.score, 1)
})

test("looping output is a hard failure", () => {
  const line = "The quick brown fox jumps over the lazy dog again and again.\n"
  const r = evaluate({ ...base, responseText: line.repeat(6) })
  assert.equal(r.score, 0)
  assert.equal(r.hardFail.id, "repetition")
})

test("truncation drags the score without hard-failing", () => {
  const r = evaluate({ ...base, finishReason: "length" })
  assert.equal(r.hardFail, null)
  assert.ok(r.score < 1)
  const entry = r.breakdown.find((b) => b.id === "truncation")
  assert.equal(entry.score, 0.5)
})

test("invalid tool-call arguments are a hard failure", () => {
  const profile = { hasTools: true }
  const r = evaluate({ ...base, profile, toolCalls: [{ function: { name: "edit", arguments: '{"path": "x"' } }] })
  assert.equal(r.score, 0)
  assert.equal(r.hardFail.id, "tool-args")
})

test("a plain-text answer to a tools request is not a failure by itself", () => {
  const profile = { hasTools: true }
  const r = evaluate({ ...base, profile, toolCalls: [] })
  assert.equal(r.hardFail, null)
  const entry = r.breakdown.find((b) => b.id === "tool-args")
  assert.equal(entry, undefined, "not applicable when no calls were made")
})

test("non-applicable evaluators are excluded from the average", () => {
  // No tools, no JSON request, short text: only refusal + empty apply.
  const r = evaluate(base, Object.keys(EVALUATORS))
  assert.equal(r.evaluated, 2)
})

test("an unknown evaluator id is skipped silently", () => {
  const r = evaluate(base, ["refusal", "does-not-exist"])
  assert.equal(r.evaluated, 1)
})
