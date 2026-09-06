"use strict"

// Fixtures are verbatim samples captured from minimax/MiniMax-M2.7 and
// gonkarouter/moonshotai/Kimi-K2.6 during Phase 1 verification.

const { test } = require("node:test")
const assert = require("node:assert")
const quirk = require("./think-tags")
const { split, ThinkTagTranslator } = quirk._internals

test("splits a paired think block out of content", () => {
  const raw =
    '<think>\nThe user asks: "What is 2+2? Answer briefly."\n\nThis is a simple arithmetic question: 2+2 = 4.\n</think>\n\n4'
  const r = split(raw)
  assert.equal(r.text, "4")
  assert.match(r.reasoning, /^The user asks/)
  assert.ok(!r.text.includes("<think>"))
})

test("content with no think tags is untouched", () => {
  const r = split("Just an answer.")
  assert.equal(r.reasoning, "")
  assert.equal(r.text, "Just an answer.")
})

test("unterminated think tag does not leak into text", () => {
  // Kimi truncated by max_tokens mid-monologue.
  const r = split('<think>The user says "hi". The conversation is simple, just greeting.')
  assert.equal(r.text, "")
  assert.match(r.reasoning, /^The user says/)
})

test("multiple think blocks are all collected", () => {
  const r = split("<think>first</think>visible one<think>second</think> visible two")
  assert.equal(r.reasoning, "firstsecond")
  assert.equal(r.text, "visible one visible two")
})

test("non-streaming envelope moves reasoning and preserves the answer", () => {
  const payload = {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "<think>\nreasoning here\n</think>\n\n4", tool_calls: null },
        finish_reason: "stop",
      },
    ],
  }
  const out = quirk.transformResponse(payload)
  assert.equal(out.choices[0].message.content, "4")
  assert.equal(out.choices[0].message.reasoning_content, "reasoning here")
  // Tool calls untouched: these providers emit native ones.
  assert.equal(out.choices[0].finish_reason, "stop")
})

test("existing reasoning_content is never clobbered", () => {
  const payload = {
    choices: [
      {
        message: { role: "assistant", content: "<think>from content</think>answer", reasoning_content: "from upstream" },
      },
    ],
  }
  const out = quirk.transformResponse(payload)
  assert.equal(out.choices[0].message.reasoning_content, "from upstream")
  assert.equal(out.choices[0].message.content, "answer")
})

// ------------------------------------------------------------------- streaming

function runStream(deltas) {
  const tr = new ThinkTagTranslator()
  const frags = []
  for (const d of deltas) frags.push(...tr.push(d))
  const fin = tr.finish()
  frags.push(...fin.fragments)
  return {
    reasoning: frags.filter((f) => f.reasoning !== undefined).map((f) => f.reasoning).join(""),
    text: frags.filter((f) => f.text !== undefined).map((f) => f.text).join(""),
    toolCalls: fin.toolCalls,
  }
}

test("streaming: token-by-token think block routed to reasoning", () => {
  const r = runStream(["<think>", "\n", "The", " user", " says", " hi", "\n", "</think>", "\n\n", "Hello", "!"])
  assert.equal(r.reasoning, "\nThe user says hi\n")
  assert.equal(r.text, "Hello!")
  assert.equal(r.toolCalls, null)
})

test("streaming: <think> split across chunks", () => {
  const r = runStream(["<thi", "nk>", "hidden", "</think>", "shown"])
  assert.equal(r.reasoning, "hidden")
  assert.equal(r.text, "shown")
})

test("streaming: </think> split across chunks", () => {
  const r = runStream(["<think>hidden", "</thi", "nk>", "shown"])
  assert.equal(r.reasoning, "hidden")
  assert.equal(r.text, "shown")
})

test("streaming: no think tags passes text through unchanged", () => {
  const r = runStream(["1, ", "2, ", "3!"])
  assert.equal(r.reasoning, "")
  assert.equal(r.text, "1, 2, 3!")
})

test("streaming: stream truncated inside a think block yields only reasoning", () => {
  const r = runStream(["<think>still thinking when the budget ran"])
  assert.equal(r.text, "")
  assert.match(r.reasoning, /still thinking/)
})

test("streaming: text before a think block is preserved", () => {
  const r = runStream(["prefix ", "<think>mid</think>", " suffix"])
  assert.equal(r.reasoning, "mid")
  assert.equal(r.text, "prefix suffix")
})
