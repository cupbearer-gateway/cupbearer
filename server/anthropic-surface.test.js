"use strict"

// The Anthropic-compatible /v1/messages surface: request mapping, response
// mapping, tool round trips, and model fallback — with the router stubbed so
// everything stays hermetic.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const router = require("./router")
const surface = require("./anthropic-surface")
const { _internals } = surface

test("messagesToOpenAI maps system, text, tool_use and tool_result", () => {
  const out = _internals.messagesToOpenAI(
    [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [{ type: "text", text: "using the tool" }, { type: "tool_use", id: "toolu_1", name: "ls", input: { path: "/tmp" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ],
    "be helpful",
  )
  assert.deepEqual(out[0], { role: "system", content: "be helpful" })
  assert.equal(out[1].content, "list files")
  assert.equal(out[2].content, "using the tool")
  assert.equal(out[2].tool_calls[0].function.name, "ls")
  assert.equal(out[3].role, "tool")
  assert.equal(out[3].tool_call_id, "toolu_1")
  assert.equal(out[3].content, "a.txt\nb.txt")
  assert.equal(out[4].content, "thanks")
})

test("toolsToOpenAI maps input_schema to parameters", () => {
  const tools = _internals.toolsToOpenAI([{ name: "get_weather", description: "d", input_schema: { type: "object", properties: { city: { type: "string" } } } }])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].function.name, "get_weather")
  assert.equal(tools[0].function.parameters.properties.city.type, "string")
  assert.equal(_internals.toolsToOpenAI([]), undefined)
})

test("openAIToAnthropic maps text, tool_calls, stop reasons and usage", () => {
  const textOnly = _internals.openAIToAnthropic(
    { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 5 } },
    "claude-x",
  )
  assert.equal(textOnly.type, "message")
  assert.equal(textOnly.stop_reason, "end_turn")
  assert.deepEqual(textOnly.content, [{ type: "text", text: "hello" }])
  assert.equal(textOnly.usage.input_tokens, 4)

  const withTools = _internals.openAIToAnthropic(
    {
      id: "chatcmpl-2",
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: [{ id: "call_9", function: { name: "ls", arguments: '{"path":"/"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: {},
    },
    "claude-x",
  )
  assert.equal(withTools.stop_reason, "tool_use")
  assert.equal(withTools.content[0].type, "tool_use")
  assert.deepEqual(withTools.content[0].input, { path: "/" })
})

test("resolvePool: pool id, provider/model escape hatch, then first-pool fallback", () => {
  const origLoad = config.load
  const origGetProvider = config.getProvider
  try {
    const pools = [{ id: "smart" }, { id: "vision" }]
    const providers = [{ id: "p1", label: "P1" }]
    config.load = () => ({ pools, providers })
    config.getProvider = (id) => providers.find((p) => p.id === id) || null

    assert.equal(_internals.resolvePool("vision").pool.id, "vision")
    assert.equal(_internals.resolvePool("p1/m1").pool._direct, true)
    const fb = _internals.resolvePool("claude-sonnet-5")
    assert.equal(fb.pool.id, "smart")
    assert.equal(fb.fallback, true, "unknown Anthropic-style model names fall back to the first pool")
    config.load = () => ({ pools: [], providers: [] })
    assert.equal(_internals.resolvePool("claude-x").pool, undefined)
  } finally {
    config.load = origLoad
    config.getProvider = origGetProvider
  }
})

test("the messages endpoint serves a completion end to end (router stubbed)", async () => {
  const origLoad = config.load
  const origGetProvider = config.getProvider
  const origDispatch = router.dispatch
  try {
    const POOL = { id: "smart", name: "Smart", keyStrategy: "round-robin", legs: [{ providerId: "p1", model: "m1" }] }
    config.load = () => ({ settings: {}, pools: [POOL], providers: [{ id: "p1", keys: [] }] })
    config.getProvider = (id) => ({ id: "p1", keys: [] })
    router.dispatch = async ({ pool, payload, res }) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-z",
          choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
      return { committed: true, providerId: "p1", keyId: "p1:key-1", attempts: [] }
    }

    const res = fakeRes()
    await runRequest(res, { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    const body = JSON.parse(res.body)
    assert.equal(res.code, 200)
    assert.equal(body.type, "message")
    assert.equal(body.model, "claude-sonnet-5", "the client's requested model is echoed back")
    assert.deepEqual(body.content, [{ type: "text", text: "hi there" }])
    assert.equal(body.usage.output_tokens, 2)
    assert.match(body.cupbearer_note, /not a configured pool/, "fallback is disclosed, never silent")
  } finally {
    config.load = origLoad
    config.getProvider = origGetProvider
    router.dispatch = origDispatch
  }
})

test("streaming requests replay the full result as Anthropic SSE events", async () => {
  const origLoad = config.load
  const origGetProvider = config.getProvider
  const origDispatch = router.dispatch
  try {
    const POOL = { id: "smart", name: "Smart", keyStrategy: "round-robin", legs: [{ providerId: "p1", model: "m1" }] }
    config.load = () => ({ settings: {}, pools: [POOL], providers: [{ id: "p1", keys: [] }] })
    config.getProvider = (id) => ({ id: "p1", keys: [] })
    router.dispatch = async ({ res }) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "chatcmpl-z", choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
      return { committed: true, providerId: "p1", keyId: "p1:key-1", attempts: [] }
    }

    const res = fakeRes()
    await runRequest(res, { model: "smart", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    for (const name of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
      assert.ok(res.body.includes(`event: ${name}`), `contains ${name}`)
    }
    assert.match(res.body, /text_delta/)
    assert.match(res.body, /"text":"hello world"/)
  } finally {
    config.load = origLoad
    config.getProvider = origGetProvider
    router.dispatch = origDispatch
  }
})

// Feed a JSON body through a real duplex stream, the way HTTP would.
function runRequest(res, body) {
  const { PassThrough } = require("node:stream")
  const req = new PassThrough()
  const done = surface.messages(req, res)
  req.end(JSON.stringify(body))
  return done
}

function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    code: 0,
    body: "",
    writeHead(code, headers) {
      this.code = code
      this.headersSent = true
    },
    write(b) {
      this.body += b
      return true
    },
    end(b) {
      if (b) this.body += b
      this.writableEnded = true
    },
  }
}
