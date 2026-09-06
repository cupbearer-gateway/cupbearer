"use strict"

const test = require("node:test")
const assert = require("node:assert")
const { profileRequest, estimateTokens } = require("./profile")

const chat = (extra = {}) => ({
  model: "any",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
})

test("a short plain chat needs the light tier and no capabilities", () => {
  const p = profileRequest(chat())
  assert.equal(p.requiredTier, 3)
  assert.deepEqual(p.capabilities, [])
  assert.equal(p.hasTools, false)
  assert.equal(p.hasImages, false)
  assert.equal(p.taskType, "chat")
})

test("tool calls bump to standard and require the tools capability", () => {
  const p = profileRequest(chat({ tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }] }))
  assert.equal(p.requiredTier, 2)
  assert.deepEqual(p.capabilities, ["tools"])
  assert.equal(p.taskType, "tools")
})

test("a wide toolset looks agentic and asks for the flagship tier", () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ type: "function", function: { name: `t${i}` } }))
  const p = profileRequest(chat({ tools }))
  assert.equal(p.requiredTier, 1)
})

test("a long agentic history asks for the flagship tier even with few tools", () => {
  const tools = [{ type: "function", function: { name: "a" } }]
  const messages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "turn" }))
  const p = profileRequest(chat({ tools, messages }))
  assert.equal(p.requiredTier, 1)
})

test("heavy generation budget asks for the flagship tier", () => {
  assert.equal(profileRequest(chat({ max_tokens: 8192 })).requiredTier, 1)
  assert.equal(profileRequest(chat({ max_tokens: 2048 })).requiredTier, 2)
})

test("a large input asks for standard quality but not flagship", () => {
  const p = profileRequest(chat({ messages: [{ role: "user", content: "x".repeat(50000) }] }))
  assert.equal(p.inputTokens >= 12000, true)
  assert.equal(p.requiredTier, 2)
})

test("image parts require the vision capability", () => {
  const p = profileRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
  })
  assert.equal(p.hasImages, true)
  assert.deepEqual(p.capabilities, ["vision"])
  assert.equal(p.taskType, "vision")
})

test("huge inputs require the long-context capability", () => {
  const p = profileRequest(chat({ messages: [{ role: "user", content: "x".repeat(270000) }] }))
  assert.deepEqual(p.capabilities, ["long-context"])
})

test("estimateTokens is rough but monotone and non-zero", () => {
  assert.ok(estimateTokens([]) === 0)
  const small = estimateTokens([{ role: "user", content: "hello" }])
  const big = estimateTokens([{ role: "user", content: "hello world again".repeat(100) }])
  assert.ok(small > 0 && big > small)
})
