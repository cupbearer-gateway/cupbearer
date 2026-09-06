"use strict"

// Every fixture below is a verbatim sample captured from
// gonkarouter/deepseek-ai/DeepSeek-V4-Flash-0731 and vyce/deepseek-v4-flash
// while diagnosing "tool call arrives with no arguments".

const { test } = require("node:test")
const assert = require("node:assert")
const quirk = require("./deepseek-tools")
const { translateContent, DeepSeekTranslator, dedupe, stripSentinels, callKey, argsAreUsable, PREAMBLE_BUDGET } =
  quirk._internals

const DS = { aggressive: true }

function run(translator, deltas) {
  const frags = []
  for (const d of deltas) frags.push(...translator.push(d))
  const { fragments, toolCalls } = translator.finish()
  frags.push(...fragments)
  return {
    text: frags.filter((f) => f.text !== undefined).map((f) => f.text).join(""),
    reasoning: frags.filter((f) => f.reasoning !== undefined).map((f) => f.reasoning).join(""),
    toolCalls,
  }
}

// ------------------------------------------------------------------ sentinels

test("strips the fullwidth-pipe DSML sentinel", () => {
  // Captured literally in a content delta after the tool call.
  assert.equal(stripSentinels("</\uFF5CDSML\uFF5Ctool_calls>"), "")
  assert.equal(stripSentinels("a</\uFF5CDSML\uFF5Ctool_calls>b"), "ab")
})

test("strips DeepSeek tool sentinels and Mistral instruction markers", () => {
  assert.equal(stripSentinels("<\uFF5Ctool\u2581calls\u2581begin\uFF5C>x"), "x")
  assert.equal(stripSentinels("done [/INST] more"), "done  more")
})

test("an ASCII pipe is not a sentinel", () => {
  assert.equal(stripSentinels("a|b <c|d> e"), "a|b <c|d> e")
})

// ----------------------------------------------------------- unterminated think

test("unterminated <think> keeps the monologue out of the answer", () => {
  const raw =
    '<think>The user wants me to run a simple shell command using the bash tool. They want me to echo "alpha" and explicitly stated "Do not explain".\n'
  const r = translateContent(raw, DS)
  assert.equal(r.text, "")
  assert.match(r.reasoning, /^The user wants me to run a simple shell command/)
})

test("paired <think> still works, so this supersedes think-tags", () => {
  const raw =
    "<think>The user wants me to run a shell command using the bash tool.\n</think>\n\n\nRunning it now."
  const r = translateContent(raw, DS)
  assert.equal(r.text, "Running it now.")
  assert.match(r.reasoning, /^The user wants me to run a shell command/)
})

// ------------------------------------------------------- hallucinated results

test("a fabricated <tool_result> block never becomes assistant text", () => {
  const raw = '<think>The user wants me to run "echo probe-raw".\n<tool_result>\nprobe-raw\n</tool_result>'
  const r = translateContent(raw, DS)
  assert.equal(r.text, "")
  assert.ok(!r.text.includes("probe-raw"))
  assert.match(r.reasoning, /probe-raw/)
})

test("a fabricated <result> transcript plus the invented follow-up turn is suppressed", () => {
  const raw =
    "<think>The user wants me to read the file at C:/Windows/win.ini using the read tool.\n" +
    "<result>\n; for 16-bit app support\n[fonts]\n[Mail]\nBiffCodePage=1252\n</result>\n\n" +
    "This appears to be a standard Windows win.ini file configuration."
  const r = translateContent(raw, DS)
  assert.ok(!r.text.includes("BiffCodePage"))
  assert.ok(!r.text.includes("standard Windows win.ini"))
  assert.match(r.reasoning, /BiffCodePage=1252/)
})

test("non-DeepSeek models keep <result> prose as real output", () => {
  const raw = "Here is the <result>value</result> you asked for."
  const loose = translateContent(raw, { aggressive: false })
  assert.match(loose.text, /<result>value<\/result>/)
  const strict = translateContent(raw, DS)
  assert.ok(!strict.text.includes("value"))
})

// ------------------------------------------------------------------- dedupe

test("collapses two identical tool calls into one", () => {
  // "List the files in the current directory" produced index 0 and index 1,
  // both {"command": "ls -la"}.
  const calls = [
    { id: "a", type: "function", function: { name: "bash", arguments: '{"command": "ls -la"}' } },
    { id: "b", type: "function", function: { name: "bash", arguments: '{"command": "ls -la"}' } },
  ]
  const out = dedupe(calls)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, "a")
})

test("dedupe ignores key order but keeps genuinely different calls", () => {
  assert.equal(callKey("bash", '{"a":1,"b":2}'), callKey("bash", '{"b":2,"a":1}'))
  const out = dedupe([
    { function: { name: "bash", arguments: '{"command":"ls"}' } },
    { function: { name: "bash", arguments: '{"command":"pwd"}' } },
    { function: { name: "read", arguments: '{"command":"ls"}' } },
  ])
  assert.equal(out.length, 3)
})

// ----------------------------------------------------------------- streaming

test("streaming: arguments split across chunks arrive whole and parseable", () => {
  // The exact fragmentation observed on the wire.
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, id: "chatcmpl-tool-8f52", type: "function", function: { name: "bash" } }])
  t.pushToolCalls([{ index: 0, function: { arguments: '{"command": "' } }])
  t.pushToolCalls([{ index: 0, function: { arguments: "echo hello-from-upstream" } }])
  t.pushToolCalls([{ index: 0, function: { arguments: '"}' } }])
  const { toolCalls } = t.finish()
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].function.name, "bash")
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { command: "echo hello-from-upstream" })
})

test("streaming: tool_calls are withheld until finish, never emitted early", () => {
  const t = new DeepSeekTranslator(DS)
  assert.deepEqual(t.pushToolCalls([{ index: 0, function: { name: "bash", arguments: "{}" } }]), [])
})

test("streaming: duplicate indices collapse and are renumbered from zero", () => {
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, id: "a", function: { name: "bash", arguments: '{"command": "ls -la"}' } }])
  t.pushToolCalls([{ index: 1, id: "b", function: { name: "bash", arguments: '{"command": "ls -la"}' } }])
  const { toolCalls } = t.finish()
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].index, 0)
})

test("streaming: content after a tool call is reasoning, not the answer", () => {
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, function: { name: "bash", arguments: '{"command":"echo hi"}' } }])
  const r = run(t, ["</\uFF5CDSML\uFF5Ctool_calls>", "hello", "-from", "-cupbearer"])
  assert.equal(r.text, "")
  assert.match(r.reasoning, /hello-from-cupbearer/)
})

test("streaming: a think tag split across chunk boundaries is still recognised", () => {
  const t = new DeepSeekTranslator(DS)
  const r = run(t, ["<thi", "nk>secret mono", "logue</thi", "nk>the answer"])
  assert.equal(r.text, "the answer")
  assert.equal(r.reasoning, "secret monologue")
})

test("streaming: a sentinel split across chunk boundaries is still stripped", () => {
  const t = new DeepSeekTranslator(DS)
  const r = run(t, ["ok </\uFF5CDSML\uFF5C", "tool_calls> done"])
  assert.equal(r.text, "ok  done")
})

test("streaming: no tool call means text passes through untouched", () => {
  const t = new DeepSeekTranslator({ aggressive: false })
  const r = run(t, ["Just ", "a plain ", "answer."])
  assert.equal(r.text, "Just a plain answer.")
  assert.equal(r.toolCalls, null)
})

// ------------------------------------------------------------ non-streaming

test("non-streaming envelope: dedupes calls and promotes finish_reason", () => {
  const payload = {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: '<think>thinking\n<tool_result>\nfake\n</tool_result>',
          reasoning_content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
            { id: "b", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        },
      },
    ],
  }
  const out = quirk.transformResponse(payload, { model: "deepseek-ai/DeepSeek-V4-Flash-0731" })
  const choice = out.choices[0]
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(choice.message.tool_calls.length, 1)
  assert.equal(choice.message.content, null)
  assert.match(choice.message.reasoning_content, /fake/)
})

test("non-streaming envelope: never clobbers reasoning the upstream supplied", () => {
  const payload = {
    choices: [{ finish_reason: "stop", message: { content: "<think>mine", reasoning_content: "theirs" } }],
  }
  const out = quirk.transformResponse(payload, { model: "deepseek-v4-flash" })
  assert.equal(out.choices[0].message.reasoning_content, "theirs")
})

// ------------------------------------------------------------- preamble hold
//
// vyce emits a token of chatter before the tool call — the observed delta order
// is exactly one " " or "." of content, then the call. Flushing that byte commits
// the HTTP response, which forfeited the router's failover when the tool call
// that followed turned out to be truncated. The preamble is therefore withheld
// until the tool-call outcome is known.

test("a short preamble before a tool call is withheld, not streamed", () => {
  const t = new DeepSeekTranslator(DS)
  // vyce's exact observed shape.
  assert.deepEqual(t.push(" "), [], "a lone space must not be flushed")
  assert.deepEqual(t.push("."), [], "nor a lone period")
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "bash", arguments: '{"command":"ls"}' } }])
  const { fragments, toolCalls } = t.finish()
  assert.equal(toolCalls.length, 1)
  // Chatter belongs to reasoning, not the answer.
  assert.equal(fragments.filter((f) => f.text !== undefined).length, 0)
})

test("a preamble longer than the budget is released so prose still streams", () => {
  const t = new DeepSeekTranslator(DS)
  const long = "x".repeat(PREAMBLE_BUDGET + 10)
  const frags = t.push(long)
  assert.ok(
    frags.some((f) => f.text?.includes("xxx")),
    "a real prose answer must not be held hostage by the budget",
  )
})

test("with no tool call the withheld preamble is emitted as the answer", () => {
  const t = new DeepSeekTranslator(DS)
  assert.deepEqual(t.push("Hi."), [])
  const { fragments, toolCalls } = t.finish()
  assert.equal(toolCalls, null)
  assert.equal(fragments.filter((f) => f.text !== undefined).map((f) => f.text).join(""), "Hi.")
})

test("preamble held across a truncated call still yields the leg verdict", () => {
  // The regression this exists for: preamble + truncated call must produce a
  // verdict and NO fragments the relay would have to flush.
  const t = new DeepSeekTranslator(DS)
  t.push(" ")
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "write", arguments: TRUNCATED } }])
  const { fragments, toolCalls, error } = t.finish()
  assert.equal(toolCalls, null)
  assert.equal(error?.cupbearerVerdict?.reason, "truncated_tool_call")
  assert.equal(fragments.filter((f) => f.text !== undefined).length, 0, "nothing may be flushed as text")
})

//
// vyce caps completions at 4096 tokens regardless of max_tokens (verified: 100,
// 4096, 6000 and absent all returned completion_tokens exactly 4096) and
// truncates a long tool call mid-JSON-string while still sending
// finish_reason "tool_calls". opencode reported:
//   Invalid input for tool write: JSON parsing failed: Unterminated string

// Verbatim head of the truncated write call vyce produced for nova.html.
const TRUNCATED = '{"filePath": "C:/Users/testuser/nova.html", "content": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head>\\n<meta charset'

test("argsAreUsable rejects truncated JSON and accepts complete JSON", () => {
  assert.equal(argsAreUsable(TRUNCATED), false)
  assert.equal(argsAreUsable('{"command":"ls"}'), true)
  // An absent argument list is normalised to {} downstream, not an error.
  assert.equal(argsAreUsable(""), true)
  assert.equal(argsAreUsable("   "), true)
})

test("streaming: truncated arguments are reported, never forwarded", () => {
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "write" } }])
  for (const piece of [TRUNCATED.slice(0, 40), TRUNCATED.slice(40)]) {
    t.pushToolCalls([{ index: 0, function: { arguments: piece } }])
  }
  const { toolCalls, error } = t.finish()
  assert.equal(toolCalls, null, "a broken call must not reach the client")
  assert.ok(error, "the failure must be surfaced")
  assert.equal(error.cupbearerVerdict.reason, "truncated_tool_call")
  // The cap is deterministic and not the key's fault: stop cleanly rather than
  // retrying or taking a working provider out of rotation.
  assert.equal(error.cupbearerVerdict.scope, "request")
  assert.equal(error.cupbearerVerdict.retry, false)
  assert.equal(error.cupbearerVerdict.keyState, "healthy")
  assert.equal(error.cupbearerVerdict.status, 422)
  assert.match(error.message, /write/)
  assert.match(error.message, /nothing ran/)
})

test("streaming: a complete call alongside nothing else still succeeds", () => {
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "write", arguments: '{"filePath":"a.txt","content":"hi"}' } }])
  const { toolCalls, error } = t.finish()
  assert.equal(error, undefined)
  assert.equal(toolCalls.length, 1)
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { filePath: "a.txt", content: "hi" })
})

test("streaming: an empty argument list is normalised to {}", () => {
  const t = new DeepSeekTranslator(DS)
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "list" } }])
  const { toolCalls, error } = t.finish()
  assert.equal(error, undefined)
  assert.equal(toolCalls[0].function.arguments, "{}")
})

test("non-streaming: a truncated call throws a classifiable verdict", () => {
  const payload = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "write", arguments: TRUNCATED } }] },
      },
    ],
  }
  assert.throws(
    () => quirk.transformResponse(payload, { model: "deepseek-v4-flash" }),
    (e) =>
      e.cupbearerVerdict?.reason === "truncated_tool_call" &&
      e.cupbearerVerdict.scope === "request" &&
      e.cupbearerVerdict.retry === false,
  )
})

test("non-streaming: a complete call passes the guard", () => {
  const payload = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      },
    ],
  }
  const out = quirk.transformResponse(payload, { model: "deepseek-v4-flash" })
  assert.equal(out.choices[0].message.tool_calls.length, 1)
})

test("the guard applies to non-DeepSeek models too — broken JSON is broken", () => {
  // Unlike the hallucination rules, this one is not model-gated: no client can
  // use unparseable arguments.
  const t = new DeepSeekTranslator({ aggressive: false })
  t.pushToolCalls([{ index: 0, id: "c", function: { name: "write", arguments: TRUNCATED } }])
  const { error } = t.finish()
  assert.equal(error?.cupbearerVerdict?.reason, "truncated_tool_call")
})

