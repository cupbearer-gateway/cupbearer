"use strict"

const { test } = require("node:test")
const assert = require("node:assert")
const quirk = require("./aistudio-think-sig")
const { cache, signatureOf, remember, restore } = quirk._internals

const SIG_A = "Ep8CCpwCARFNMg8n9FeRj6wRmcwasb1vDVOOrh5olEsbh"
const SIG_B = "EuYECuMEARFNMg/7luHEPYpRNF4RV3JQgbsQ3DPD"

function fresh() {
  cache.clear()
}

test("remember stores a signature from a tool call with extra_content", () => {
  fresh()
  remember({ id: "call_1", extra_content: { google: { thought_signature: SIG_A } } })
  assert.equal(cache.get("call_1").sig, SIG_A)
})

test("remember ignores calls without a signature and without an id", () => {
  fresh()
  remember({ id: "call_1" })
  remember({ extra_content: { google: { thought_signature: SIG_A } } })
  assert.equal(cache.size, 0)
})

test("filterStreamLine caches and passes every line through unchanged", () => {
  fresh()
  const chunk = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ id: "call_9", extra_content: { google: { thought_signature: SIG_B } } }] } }],
  })
  const line = `data: ${chunk}\n`
  assert.equal(quirk.filterStreamLine(line), true)
  assert.equal(quirk.filterStreamLine("data: [DONE]\n"), true)
  assert.equal(quirk.filterStreamLine(": keepalive\n"), true)
  assert.equal(cache.get("call_9").sig, SIG_B)
})

test("transformResponse caches signatures from a non-streaming payload", () => {
  fresh()
  const payload = {
    choices: [{ message: { tool_calls: [{ id: "call_5", extra_content: { google: { thought_signature: SIG_A } } }] } }],
  }
  quirk.transformResponse(JSON.parse(JSON.stringify(payload)))
  assert.equal(cache.get("call_5").sig, SIG_A)
})

test("restore injects the cached signature onto an assistant tool call", () => {
  fresh()
  cache.set("call_1", { sig: SIG_A, at: Date.now() })
  const msg = { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] }
  const out = restore(msg)
  assert.deepEqual(out.tool_calls[0].extra_content, { google: { thought_signature: SIG_A } })
})

test("restore leaves an untouched copy when nothing matches", () => {
  fresh()
  const msg = { role: "assistant", tool_calls: [{ id: "call_none", type: "function", function: {} }] }
  assert.equal(restore(msg), msg)
})

test("restore does not double-inject a signature the client already preserved", () => {
  fresh()
  cache.set("call_1", { sig: SIG_A, at: Date.now() })
  const msg = {
    role: "assistant",
    tool_calls: [{ id: "call_1", extra_content: { google: { thought_signature: SIG_B } }, function: {} }],
  }
  const out = restore(msg)
  assert.equal(out, msg) // untouched: SIG_B already there, SIG_A must not clobber it
})

test("transformRequest restores every cached call across the whole history", () => {
  fresh()
  cache.set("call_1", { sig: SIG_A, at: Date.now() })
  cache.set("call_2", { sig: SIG_B, at: Date.now() })
  const body = {
    model: "gemini-flash",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "a", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "b", arguments: "{}" } }] },
    ],
  }
  const clone = JSON.parse(JSON.stringify(body))
  const out = quirk.transformRequest(clone)
  assert.deepEqual(out.messages[1].tool_calls[0].extra_content, { google: { thought_signature: SIG_A } })
  assert.deepEqual(out.messages[3].tool_calls[0].extra_content, { google: { thought_signature: SIG_B } })
  // User messages pass through structurally untouched.
  assert.deepEqual(out.messages[0], clone.messages[0])
  // Tool results get the cached function name re-injected (restoreToolResult),
  // so the upstream encoder can always match a result to its call.
  assert.deepEqual(out.messages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: "ok",
    name: "a",
    extra_content: { google: { function_name: "a" } },
  })
})

test("transformRequest with nothing cached returns the body unchanged", () => {
  fresh()
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "call_1", function: {} }] },
    ],
  }
  const clone = JSON.parse(JSON.stringify(body))
  const out = quirk.transformRequest(clone)
  assert.equal(out, clone) // no cache hit => same object, no re-injection attempt
  assert.deepEqual(out.messages[1].tool_calls[0].extra_content, undefined)
})

test("expired cache entries are pruned", () => {
  fresh()
  cache.set("old", { sig: SIG_A, at: Date.now() - 31 * 60 * 1000 })
  cache.set("new", { sig: SIG_B, at: Date.now() })
  remember({ id: "trigger", extra_content: { google: { thought_signature: SIG_A } } })
  assert.equal(cache.has("old"), false)
  assert.equal(cache.has("new"), true)
})

test("a full two-turn round trip restores the signature end to end", () => {
  fresh()
  // What AIStudio2API streams back (chunk with signature).
  const streamed = {
    choices: [{ delta: { tool_calls: [{ id: "call_t1", extra_content: { google: { thought_signature: SIG_A } } }] } }],
  }
  assert.equal(quirk.filterStreamLine(`data: ${JSON.stringify(streamed)}\n`), true)

  // What ZCode sends next: history echoed without any extra_content.
  const roundTrip = {
    model: "gemini-flash",
    messages: [
      { role: "user", content: "Use the tool" },
      { role: "assistant", tool_calls: [{ id: "call_t1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_t1", content: "done" },
    ],
  }
  const out = quirk.transformRequest(JSON.parse(JSON.stringify(roundTrip)))
  assert.deepEqual(out.messages[1].tool_calls[0].extra_content, { google: { thought_signature: SIG_A } })
})
