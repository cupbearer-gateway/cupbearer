"use strict"

// Regression tests for the relay's handling of NATIVE upstream tool_calls while
// a stream translator is attached.
//
// The bug these lock down: the relay used to set finished = true on the FIRST
// chunk containing delta.tool_calls and return. Upstreams stream a tool call's
// arguments across many chunks (gonkarouter sent 5, agentrouter 13), so the
// client received the function name with its arguments truncated to "" — which
// surfaced in opencode as SchemaError(Missing key at ["command"]).

const { test } = require("node:test")
const assert = require("node:assert")
const { relay } = require("./relay")
const quirks = require("./quirks")

// Minimal ServerResponse stand-in: collects everything written.
function fakeRes() {
  return {
    chunks: [],
    writableEnded: false,
    write(s) {
      this.chunks.push(s)
      return true
    },
    get text() {
      return this.chunks.join("")
    },
  }
}

function sseBody(lines) {
  const encoder = new TextEncoder()
  const payload = lines.map((l) => (typeof l === "string" ? l : `data: ${JSON.stringify(l)}`)).join("\n") + "\n"
  return {
    body: {
      getReader() {
        let sent = false
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: encoder.encode(payload) })),
          cancel: async () => {},
        }
      },
    },
  }
}

// Reassemble what a client would see.
function parse(res) {
  const byIndex = new Map()
  let content = ""
  let reasoning = ""
  const finishReasons = []
  let doneCount = 0

  for (const line of res.text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const d = t.slice(5).trim()
    if (d === "[DONE]") {
      doneCount++
      continue
    }
    let c
    try {
      c = JSON.parse(d)
    } catch {
      continue
    }
    const choice = c.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    for (const tc of delta.tool_calls ?? []) {
      const ix = tc.index ?? 0
      if (!byIndex.has(ix)) byIndex.set(ix, { name: null, args: "" })
      const rec = byIndex.get(ix)
      if (tc.function?.name) rec.name = tc.function.name
      if (tc.function?.arguments) rec.args += tc.function.arguments
    }
    if (typeof delta.content === "string") content += delta.content
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
    if (choice.finish_reason) finishReasons.push(choice.finish_reason)
  }
  return { calls: [...byIndex.values()], content, reasoning, finishReasons, doneCount }
}

const CHUNK = (delta, finish_reason = null) => ({
  id: "x",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, logprobs: null, finish_reason }],
})

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
]

async function run({ lines, quirkIds, model = "m" }) {
  const res = fakeRes()
  const applied = quirks.compose(quirkIds)
  const out = await relay({
    upstream: sseBody(lines),
    res,
    applied,
    ctx: { provider: { id: "p" }, model, stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })
  return { ...parse(res), outcome: out }
}

// The exact fragmentation captured from gonkarouter/DeepSeek-V4-Flash-0731.
const GONKA_LINES = [
  CHUNK({ content: "<think>The user wants me to run a command.\n" }),
  CHUNK({ tool_calls: [{ index: 0, id: "chatcmpl-tool-a253", type: "function", function: { name: "bash" } }] }),
  CHUNK({ tool_calls: [{ index: 0, function: { arguments: '{"command": "' } }] }),
  CHUNK({ tool_calls: [{ index: 0, function: { arguments: "echo hello-from-cupbearer" } }] }),
  CHUNK({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }),
  CHUNK({ content: "</\uFF5CDSML\uFF5Ctool_calls>" }),
  CHUNK({ content: "hello-from-cupbearer" }),
  CHUNK({}, "tool_calls"),
  "data: [DONE]",
]

test("tool_call arguments split across chunks survive with a translator attached", async () => {
  // Before the fix this produced args === "" and opencode reported
  // SchemaError(Missing key at ["command"]).
  const r = await run({ lines: GONKA_LINES, quirkIds: ["deepseek-tools"], model: "deepseek-ai/DeepSeek-V4-Flash-0731" })
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, "bash")
  assert.deepEqual(JSON.parse(r.calls[0].args), { command: "echo hello-from-cupbearer" })
})

test("a truncating translator is not what drops arguments — think-tags passes them through too", async () => {
  // think-tags has no pushToolCalls, so the relay forwards natively. It must
  // still forward EVERY fragment rather than stopping at the first.
  const r = await run({ lines: GONKA_LINES, quirkIds: ["think-tags"] })
  assert.equal(r.calls.length, 1)
  assert.deepEqual(JSON.parse(r.calls[0].args), { command: "echo hello-from-cupbearer" })
})

test("finish_reason is tool_calls and exactly one [DONE] is written", async () => {
  const r = await run({ lines: GONKA_LINES, quirkIds: ["deepseek-tools"], model: "deepseek-v4-flash" })
  assert.deepEqual(r.finishReasons, ["tool_calls"])
  assert.equal(r.doneCount, 1)
})

test("no duplicate finish chunk when the upstream carries finish_reason on the tool_calls chunk", async () => {
  // minimax emits tool_calls and finish_reason in the same chunk, then a second
  // bare finish chunk. Forwarding plus synthesising produced three.
  const lines = [
    CHUNK({ reasoning_content: "thinking" }),
    CHUNK(
      { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"echo x"}' } }] },
      "tool_calls",
    ),
    CHUNK({}, "tool_calls"),
    "data: [DONE]",
  ]
  const r = await run({ lines, quirkIds: ["think-tags"] })
  assert.deepEqual(r.finishReasons, ["tool_calls"])
  assert.equal(r.calls.length, 1)
})

test("agentrouter's finish_reason-less stream still terminates as tool_calls", async () => {
  // agentrouter never sends finish_reason at all; without synthesis the call
  // dangles and the client waits forever.
  const lines = [
    CHUNK({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "bash" } }] }),
    CHUNK({ tool_calls: [{ index: 0, function: { arguments: '{"command": "' } }] }),
    CHUNK({ tool_calls: [{ index: 0, function: { arguments: 'echo agentprobe"}' } }] }),
    "data: [DONE]",
  ]
  const r = await run({ lines, quirkIds: ["waf-headers", "deepseek-tools"], model: "deepseek-v4-flash" })
  assert.deepEqual(r.finishReasons, ["tool_calls"])
  assert.deepEqual(JSON.parse(r.calls[0].args), { command: "echo agentprobe" })
})

test("duplicated tool calls are collapsed before reaching the client", async () => {
  const lines = [
    CHUNK({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "bash", arguments: '{"command": "ls -la"}' } }] }),
    CHUNK({ content: " [/INST] " }),
    CHUNK({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "bash", arguments: '{"command": "ls -la"}' } }] }),
    CHUNK({}, "tool_calls"),
    "data: [DONE]",
  ]
  const r = await run({ lines, quirkIds: ["deepseek-tools"], model: "deepseek-v4-flash" })
  assert.equal(r.calls.length, 1)
  assert.deepEqual(JSON.parse(r.calls[0].args), { command: "ls -la" })
})

test("hallucinated transcript and sentinels never reach client content", async () => {
  const r = await run({ lines: GONKA_LINES, quirkIds: ["deepseek-tools"], model: "deepseek-v4-flash" })
  assert.ok(!r.content.includes("\uFF5C"), "fullwidth-pipe sentinel leaked")
  assert.ok(!r.content.includes("<think>"), "think tag leaked")
  assert.ok(!r.content.includes("hello-from-cupbearer"), "fabricated tool output became the answer")
  assert.match(r.reasoning, /The user wants me to run a command/)
})

test("a plain text stream with no tool call is unaffected", async () => {
  const lines = [CHUNK({ content: "Just an answer." }), CHUNK({}, "stop"), "data: [DONE]"]
  const r = await run({ lines, quirkIds: ["deepseek-tools"], model: "deepseek-v4-flash" })
  assert.equal(r.content, "Just an answer.")
  assert.deepEqual(r.finishReasons, ["stop"])
  assert.equal(r.calls.length, 0)
})

test("passthrough (no quirks) forwards every byte verbatim", async () => {
  const r = await run({ lines: GONKA_LINES, quirkIds: [] })
  assert.equal(r.calls.length, 1)
  assert.deepEqual(JSON.parse(r.calls[0].args), { command: "echo hello-from-cupbearer" })
  assert.equal(r.doneCount, 1)
})

// Verbatim head of the truncated write call vyce produced for nova.html.
const TRUNCATED =
  '{"filePath": "C:/Users/testuser/nova.html", "content": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head'

test("truncated tool arguments are withheld so the request can stop cleanly", async () => {
  // vyce's 4096-token ceiling cuts a long write call mid-JSON-string while
  // still sending finish_reason "tool_calls". Because the translator buffers
  // tool calls, nothing has been flushed when this is discovered — so the relay
  // must stay silent and report the verdict rather than write an error.
  const lines = [
    CHUNK({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "write" } }] }),
    CHUNK({ tool_calls: [{ index: 0, function: { arguments: TRUNCATED } }] }),
    CHUNK({}, "tool_calls"),
    "data: [DONE]",
  ]
  const res = fakeRes()
  const out = await relay({
    upstream: sseBody(lines),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "vyce" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })

  assert.equal(out.errored, true)
  assert.equal(out.wrote, false, "nothing may be flushed, or a clean stop is impossible")
  assert.equal(res.text, "")
  assert.equal(out.verdict.reason, "truncated_tool_call")
  // request scope + no retry: the cap is deterministic, so stop with a readable
  // reason rather than retrying or blaming the key.
  assert.equal(out.verdict.scope, "request")
  assert.equal(out.verdict.retry, false)
  assert.match(out.errorMessage, /output cap/)
})

test("truncation discovered after bytes are flushed is reported inline instead", async () => {
  const lines = [
    // Long enough to exceed the preamble budget, so the response really is
    // committed before the tool call is judged.
    CHUNK({ content: "Writing the file now. ".repeat(20) }),
    CHUNK({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "write", arguments: TRUNCATED } }] }),
    CHUNK({}, "tool_calls"),
    "data: [DONE]",
  ]
  const res = fakeRes()
  const out = await relay({
    upstream: sseBody(lines),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "vyce" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })

  assert.equal(out.wrote, true)
  assert.equal(out.verdict.reason, "truncated_tool_call")
  assert.match(res.text, /"type":"truncated_tool_call"/)
  const r = parse(res)
  assert.equal(r.calls.length, 0, "the broken call must not reach the client")
  assert.equal(r.doneCount, 1)
})

test("onFirstByte fires exactly once, immediately before the first write", async () => {
  let calls = 0
  let textAtFirstByte = null
  const res = fakeRes()
  await relay({
    upstream: sseBody(GONKA_LINES),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "p" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
    onFirstByte: () => {
      calls++
      textAtFirstByte = res.text
    },
  })
  assert.equal(calls, 1)
  assert.equal(textAtFirstByte, "", "headers must be written before any body byte")
})

test("a complete tool call reports no verdict", async () => {
  const res = fakeRes()
  const out = await relay({
    upstream: sseBody(GONKA_LINES),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "p" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })
  assert.equal(out.errored, false)
  assert.equal(out.verdict, null)
})

test("an in-stream error before any byte is withheld and handed back for classification", async () => {
  // vyce answers 200 + text/event-stream then emits this instead of content.
  const errObj = {
    error: { message: "An internal error occurred. Please try again later.", type: "server_error", code: "internal_error" },
  }
  const res = fakeRes()
  const out = await relay({
    upstream: sseBody([errObj, "data: [DONE]"]),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "vyce" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })
  assert.equal(out.errored, true)
  assert.equal(out.wrote, false)
  assert.equal(res.text, "", "withheld so the router can fail over")
  assert.match(out.errorMessage, /internal error occurred/)
  assert.equal(out.errorBody.error.code, "internal_error")
})

test("an in-stream error after bytes are flushed is forwarded to the client", async () => {
  const errObj = { error: { message: "boom", type: "server_error" } }
  const res = fakeRes()
  const out = await relay({
    // Long enough to exceed the translator's preamble budget, so bytes really
    // are on the wire by the time the error arrives.
    upstream: sseBody([CHUNK({ content: "x".repeat(400) }), errObj, "data: [DONE]"]),
    res,
    applied: quirks.compose(["deepseek-tools"]),
    ctx: { provider: { id: "vyce" }, model: "deepseek-v4-flash", stream: true, tools: TOOLS },
    chunkTimeoutMs: 5000,
  })
  assert.equal(out.wrote, true)
  assert.match(res.text, /"message":"boom"/)
})
