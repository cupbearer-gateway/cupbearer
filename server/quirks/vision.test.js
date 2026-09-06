"use strict"

// Fixtures are verbatim from the live upstreams, noted per case.

const { test } = require("node:test")
const assert = require("node:assert")

const nvidia = require("./nvidia-nim")
const openrouter = require("./openrouter")

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }

function imageBody(model, extra = {}) {
  return {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, IMAGE_PART] }],
    ...extra,
  }
}

function textBody(model, extra = {}) {
  return { model, messages: [{ role: "user", content: "hello" }], ...extra }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
]

// ------------------------------------------------------------------ nvidia-nim

const LLAMA_VISION = "meta/llama-3.2-11b-vision-instruct"
const OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"

test("nvidia: hasImage detects an image part and ignores plain text", () => {
  assert.equal(nvidia._internals.hasImage(imageBody(LLAMA_VISION)), true)
  assert.equal(nvidia._internals.hasImage(textBody(LLAMA_VISION)), false)
  // Array content with no image part — a shape opencode does send.
  assert.equal(
    nvidia._internals.hasImage({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    false,
  )
  assert.equal(nvidia._internals.hasImage({}), false)
})

// Live: llama-3.2-11b-vision-instruct + 1 image + tools returned
// {"message":"The number of image tokens (0) must be the same as the number of
//  images (1)","type":"BadRequestError","code":400} on 3/3 attempts.
test("nvidia: drops tools on an image request to a llama vision model", () => {
  const out = nvidia.transformRequest(imageBody(LLAMA_VISION, { tools: TOOLS }), { model: LLAMA_VISION })
  assert.equal("tools" in out, false)
  assert.equal("tool_choice" in out, false)
  assert.deepEqual(out.messages[0].content[1], IMAGE_PART)
})

// tools:[] and tool_choice:"none" failed identically on the wire, so the key's
// presence is the trigger, not its contents.
test("nvidia: drops an empty tools array and tool_choice too", () => {
  const out = nvidia.transformRequest(imageBody(LLAMA_VISION, { tools: [], tool_choice: "none" }), {
    model: LLAMA_VISION,
  })
  assert.equal("tools" in out, false)
  assert.equal("tool_choice" in out, false)
})

test("nvidia: keeps tools on a TEXT request to a llama vision model", () => {
  const out = nvidia.transformRequest(textBody(LLAMA_VISION, { tools: TOOLS }), { model: LLAMA_VISION })
  assert.deepEqual(out.tools, TOOLS)
})

// omni served an image + tools request correctly (2.7s, right answer), so the
// tool strip must not apply to it.
test("nvidia: keeps tools on an image request to omni", () => {
  const out = nvidia.transformRequest(imageBody(OMNI, { tools: TOOLS }), { model: OMNI })
  assert.deepEqual(out.tools, TOOLS)
})

test("nvidia: disables omni thinking on an image request", () => {
  const out = nvidia.transformRequest(imageBody(OMNI), { model: OMNI })
  assert.deepEqual(out.chat_template_kwargs, { thinking: false })
})

test("nvidia: leaves omni thinking alone on a text request", () => {
  const out = nvidia.transformRequest(textBody(OMNI), { model: OMNI })
  assert.equal(out.chat_template_kwargs, undefined)
})

test("nvidia: never overrides chat_template_kwargs the caller set", () => {
  const out = nvidia.transformRequest(imageBody(OMNI, { chat_template_kwargs: { thinking: true } }), { model: OMNI })
  assert.deepEqual(out.chat_template_kwargs, { thinking: true })
})

test("nvidia: does not mutate the body it was given", () => {
  const body = imageBody(LLAMA_VISION, { tools: TOOLS })
  nvidia.transformRequest(body, { model: LLAMA_VISION })
  assert.deepEqual(body.tools, TOOLS)
})

// ------------------------------------------------------------------ openrouter

const OR_DOTS = "dots-studio/dots-3-note-preview:free"
const OR_OMNI = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
const OR_PLAIN = "minimax/minimax-m3:free"

// Live: dots-3 with max_tokens 120 produced 454 chars of reasoning, empty
// content and finish_reason "length".
test("openrouter: disables reasoning on an image request to a reasoning model", () => {
  for (const model of [OR_DOTS, OR_OMNI]) {
    const out = openrouter.transformRequest(imageBody(model), { model })
    assert.deepEqual(out.reasoning, { enabled: false }, model)
  }
})

test("openrouter: leaves reasoning alone on a text request", () => {
  const out = openrouter.transformRequest(textBody(OR_DOTS), { model: OR_DOTS })
  assert.equal(out.reasoning, undefined)
})

test("openrouter: does not touch a non-reasoning model", () => {
  const out = openrouter.transformRequest(imageBody(OR_PLAIN), { model: OR_PLAIN })
  assert.equal(out.reasoning, undefined)
})

test("openrouter: respects an explicit reasoning setting from the caller", () => {
  const body = imageBody(OR_DOTS, { reasoning: { effort: "high" } })
  const out = openrouter.transformRequest(body, { model: OR_DOTS })
  assert.deepEqual(out.reasoning, { effort: "high" })
})

// Live keepalive, observed 1–6 times before the first real delta on free models.
test("openrouter: drops SSE comment keepalives, keeps data lines", () => {
  assert.equal(openrouter.filterStreamLine(": OPENROUTER PROCESSING\n"), false)
  assert.equal(openrouter.filterStreamLine(":\n"), false)
  // Leading whitespace still means a comment.
  assert.equal(openrouter.filterStreamLine("  : OPENROUTER PROCESSING"), false)
  assert.equal(openrouter.filterStreamLine('data: {"choices":[{"delta":{"content":"hi"}}]}\n'), true)
  assert.equal(openrouter.filterStreamLine("data: [DONE]\n"), true)
  assert.equal(openrouter.filterStreamLine("\n"), true)
})

// A colon inside a data line must not be mistaken for a comment marker.
test("openrouter: a data line whose JSON contains a colon survives", () => {
  assert.equal(openrouter.filterStreamLine('data: {"a":":OPENROUTER PROCESSING"}'), true)
})

test("openrouter: sets attribution headers without dropping authorization", () => {
  const out = openrouter.transformHeaders({ authorization: "Bearer sk-or-v1-x", "content-type": "application/json" })
  assert.equal(out.authorization, "Bearer sk-or-v1-x")
  assert.equal(out["http-referer"], "https://opencode.ai")
  assert.equal(out["x-title"], "opencode (cupbearer)")
})
