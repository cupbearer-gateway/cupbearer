"use strict"

// Ported from ~/.config/opencode/hcnapi-proxy.test.js, converted to node:test.
// These fixtures are real on-the-wire samples from api.hcnsec.cn, including the
// exact token-splitting pattern its SSE stream produces.

const { test } = require("node:test")
const assert = require("node:assert")
const quirk = require("./qwen-xml")

const { translateContent, StreamTranslator, rewriteNonStreaming, schemasFromTools, findParamEnd } = quirk._internals

const tools = [
  {
    type: "function",
    function: {
      name: "read",
      parameters: { type: "object", properties: { filePath: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
          background: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "todowrite",
      parameters: { type: "object", properties: { todos: { type: "array" } } },
    },
  },
]
const schemas = schemasFromTools(tools)

test("single tool call, reasoning split out of content", () => {
  const raw =
    "The user is asking me to read /etc/hostname. Let me use the read tool.\n</think>\n\n<tool_call>\n<function=read>\n<parameter=filePath>\n/etc/hostname\n</parameter>\n</function>\n</tool_call>"
  const r = translateContent(raw, schemas)
  assert.strictEqual(r.text, "")
  assert.match(r.reasoning, /^The user is asking me to read/)
  assert.strictEqual(r.toolCalls.length, 1)
  assert.strictEqual(r.toolCalls[0].function.name, "read")
  assert.deepStrictEqual(JSON.parse(r.toolCalls[0].function.arguments), { filePath: "/etc/hostname" })
})

test("number and boolean coercion from XML strings", () => {
  const raw =
    "run it\n</think>\n\n<tool_call>\n<function=bash>\n<parameter=command>\nls -la /tmp\n</parameter>\n<parameter=background>\ntrue\n</parameter>\n<parameter=timeout>\n5000\n</parameter>\n</function>\n</tool_call>"
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.deepStrictEqual(args, { command: "ls -la /tmp", background: true, timeout: 5000 })
  assert.strictEqual(typeof args.timeout, "number")
  assert.strictEqual(typeof args.background, "boolean")
})

test("two tool calls in one turn get unique ids", () => {
  const raw =
    "parallel\n</think>\n\n<tool_call>\n<function=read>\n<parameter=filePath>\n/etc/hostname\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=read>\n<parameter=filePath>\n/etc/hosts\n</parameter>\n</function>\n</tool_call>"
  const r = translateContent(raw, schemas)
  assert.strictEqual(r.toolCalls.length, 2)
  assert.notStrictEqual(r.toolCalls[0].id, r.toolCalls[1].id)
  assert.deepStrictEqual(JSON.parse(r.toolCalls[1].function.arguments), { filePath: "/etc/hosts" })
})

test("multiline string content preserved verbatim", () => {
  const py =
    'def greet(name):\n    """Print a greeting.\n\n    Args:\n        name: who\n    """\n    print(f"Hello, {name}!")\n'
  const raw = `think\n</think>\n\n<tool_call>\n<function=write>\n<parameter=filePath>\n/tmp/hello.py\n</parameter>\n<parameter=content>\n${py}</parameter>\n</function>\n</tool_call>`
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.strictEqual(args.filePath, "/tmp/hello.py")
  assert.ok(args.content.includes('"""Print a greeting.'))
  assert.ok(args.content.includes('print(f"Hello, {name}!")'))
  assert.ok(!args.content.includes("</parameter>"))
})

test("array-of-objects param parsed into a real JSON array", () => {
  const todos =
    '[{"content": "a", "priority": "high", "status": "pending"}, {"content": "b", "priority": "low", "status": "pending"}]'
  const raw = `t\n</think>\n\n<tool_call>\n<function=todowrite>\n<parameter=todos>\n${todos}\n</parameter>\n</function>\n</tool_call>`
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.ok(Array.isArray(args.todos))
  assert.strictEqual(args.todos.length, 2)
  assert.strictEqual(args.todos[0].content, "a")
})

test("plain answer: reasoning stripped, no leaked </think>", () => {
  const raw = "user asks about HTTP. simple.\n</think>\n\nHTTP stands for **Hypertext Transfer Protocol**."
  const r = translateContent(raw, schemas)
  assert.strictEqual(r.toolCalls.length, 0)
  assert.strictEqual(r.text, "HTTP stands for **Hypertext Transfer Protocol**.")
  assert.match(r.reasoning, /^user asks about HTTP/)
  assert.ok(!r.text.includes("</think>"))
})

test("JSON-body tool_call variant also parsed", () => {
  const raw = 't\n</think>\n\n<tool_call>\n{"name": "read", "arguments": {"filePath": "/tmp/x"}}\n</tool_call>'
  const r = translateContent(raw, schemas)
  assert.strictEqual(r.toolCalls.length, 1)
  assert.deepStrictEqual(JSON.parse(r.toolCalls[0].function.arguments), { filePath: "/tmp/x" })
})

test("content without </think> passes through as text", () => {
  const r = translateContent("Just a direct answer with no think marker.", schemas)
  assert.strictEqual(r.reasoning, "")
  assert.strictEqual(r.text, "Just a direct answer with no think marker.")
})

// ------------------------------------------------------------------- streaming

function runStream(deltas) {
  const tr = new StreamTranslator(schemas)
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

test("streaming: token-by-token tool call reconstructed", () => {
  // Exactly the token pattern observed on the wire, including a split "</think>".
  const deltas = [
    "", "The", " user", " wants", " a", " file", ".", "\n", "</think>", "\n\n",
    "<tool_call>", "\n", "<", "function", "=read", ">", "\n", "<", "parameter", "=", "filePath", ">", "\n",
    "/etc", "/", "hostname", "\n", "</", "parameter", ">", "\n", "</", "function", ">", "\n", "</tool_call>",
  ]
  const r = runStream(deltas)
  assert.strictEqual(r.text, "")
  assert.strictEqual(r.reasoning, "The user wants a file.\n")
  assert.strictEqual(r.toolCalls.length, 1)
  assert.deepStrictEqual(JSON.parse(r.toolCalls[0].function.arguments), { filePath: "/etc/hostname" })
})

test("streaming: </think> split across chunks handled", () => {
  const r = runStream(["reason here", "</thi", "nk>", "visible ", "answer"])
  assert.strictEqual(r.reasoning, "reason here")
  assert.strictEqual(r.text, "visible answer")
  assert.strictEqual(r.toolCalls, null)
})

test("streaming: <tool_call> split across chunks handled", () => {
  const r = runStream([
    "r",
    "</think>",
    "pre ",
    "<tool",
    "_call>",
    "<function=read><parameter=filePath>\n/a\n</parameter></function></tool_call>",
  ])
  assert.strictEqual(r.text, "pre")
  assert.strictEqual(r.toolCalls.length, 1)
  assert.deepStrictEqual(JSON.parse(r.toolCalls[0].function.arguments), { filePath: "/a" })
})

test("streaming: text-only answer emits no tool_calls", () => {
  const r = runStream(["thinking", "</think>", "\n\n", "The answer ", "is 42."])
  assert.strictEqual(r.text, "The answer is 42.")
  assert.strictEqual(r.toolCalls, null)
})

test("non-streaming envelope: tool_calls and finish_reason rewritten", () => {
  const payload = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            "t\n</think>\n\n<tool_call>\n<function=read>\n<parameter=filePath>\n/x\n</parameter>\n</function>\n</tool_call>",
          reasoning_content: null,
          tool_calls: null,
        },
        finish_reason: "stop",
      },
    ],
  }
  const out = rewriteNonStreaming(payload, schemas)
  const c = out.choices[0]
  assert.strictEqual(c.finish_reason, "tool_calls")
  assert.strictEqual(c.message.content, null)
  assert.strictEqual(c.message.tool_calls.length, 1)
  assert.strictEqual(c.message.tool_calls[0].type, "function")
  assert.strictEqual(c.message.tool_calls[0].index, undefined)
  assert.ok(c.message.tool_calls[0].id)
  assert.strictEqual(c.message.reasoning_content, "t")
})

// --------------------------------------------- structural markers inside values
//
// Parameter values are arbitrary strings, so every XML marker the parser looks
// for can legitimately appear INSIDE one. Captured verbatim from
// hcnapi/Qwen3.8-27B when asked to write a file documenting the tool-call format:
//
//   <parameter=content>
//   The tag </parameter> ends a value and <tool_call> starts a call.
//   </parameter>
//   <parameter=filePath>
//   C:/Users/testuser/t2.md
//   </parameter>
//
// A non-greedy match stopped at the first </parameter> and truncated the value
// to "The tag " — valid JSON, valid tool call, silently corrupted file. There was
// no error anywhere, which makes this the worst possible failure mode.

const NESTED_CLOSE_SAMPLE =
  "reasoning\n</think>\n\n<tool_call>\n<function=write>\n<parameter=content>\n" +
  "The tag </parameter> ends a value and <tool_call> starts a call.\n" +
  "</parameter>\n<parameter=filePath>\nC:/Users/testuser/t2.md\n</parameter>\n</function>\n</tool_call>"

test("a literal </parameter> inside a value does not truncate it", () => {
  const r = translateContent(NESTED_CLOSE_SAMPLE, schemas)
  assert.strictEqual(r.toolCalls.length, 1)
  const args = JSON.parse(r.toolCalls[0].function.arguments)
  assert.strictEqual(args.content, "The tag </parameter> ends a value and <tool_call> starts a call.")
  // The parameter that FOLLOWS the tricky value must still be found.
  assert.strictEqual(args.filePath, "C:/Users/testuser/t2.md")
})

test("a literal </tool_call> inside a value does not end the call", () => {
  const raw =
    "t\n</think>\n\n<tool_call>\n<function=write>\n<parameter=content>\nEvery call ends with </tool_call> on its own line.\n</parameter>\n<parameter=filePath>\n/tmp/doc.md\n</parameter>\n</function>\n</tool_call>"
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.strictEqual(args.content, "Every call ends with </tool_call> on its own line.")
  assert.strictEqual(args.filePath, "/tmp/doc.md")
})

test("a literal </function> inside a value does not end the block", () => {
  const raw =
    "t\n</think>\n\n<tool_call>\n<function=write>\n<parameter=content>\nClose the block with </function> after the params.\n</parameter>\n<parameter=filePath>\n/tmp/d.md\n</parameter>\n</function>\n</tool_call>"
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.strictEqual(args.content, "Close the block with </function> after the params.")
  assert.strictEqual(args.filePath, "/tmp/d.md")
})

test("a full nested tool-call example inside a value survives intact", () => {
  const doc =
    "Example:\n<tool_call>\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\nThat is the shape."
  const raw = `t\n</think>\n\n<tool_call>\n<function=write>\n<parameter=filePath>\n/tmp/guide.md\n</parameter>\n<parameter=content>\n${doc}\n</parameter>\n</function>\n</tool_call>`
  const r = translateContent(raw, schemas)
  // One call — the example inside the value must not become a second one.
  assert.strictEqual(r.toolCalls.length, 1)
  const args = JSON.parse(r.toolCalls[0].function.arguments)
  assert.strictEqual(args.filePath, "/tmp/guide.md")
  assert.strictEqual(args.content, doc)
})

test("findParamEnd picks the close that is followed by real structure", () => {
  const s = "value with </parameter> inside\n</parameter>\n<parameter=next>\n"
  const { value } = findParamEnd(s, 0)
  assert.strictEqual(value, "value with </parameter> inside\n")
})

test("an unterminated value keeps everything rather than dropping it", () => {
  // Stream cut off mid-value: better to surface a long value than an empty one.
  const raw = "t\n</think>\n\n<tool_call>\n<function=write>\n<parameter=content>\nhalf a file and then noth"
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.match(args.content, /^half a file/)
})

test("streaming: a nested </parameter> survives token-by-token delivery", () => {
  // The upstream splits tags across chunks, so the value scan must work on the
  // reassembled buffer rather than per-chunk.
  const deltas = [
    "reason",
    "</think>",
    "<tool_call>\n<function=write>\n<parameter=content>\n",
    "The tag </",
    "parameter",
    "> ends a value",
    " and <tool_call> starts a call.\n",
    "</parameter>\n<parameter=filePath>\n",
    "C:/Users/testuser/t2.md\n</parameter>\n</function>\n</tool_call>",
  ]
  const r = runStream(deltas)
  assert.strictEqual(r.toolCalls.length, 1)
  const args = JSON.parse(r.toolCalls[0].function.arguments)
  assert.strictEqual(args.content, "The tag </parameter> ends a value and <tool_call> starts a call.")
  assert.strictEqual(args.filePath, "C:/Users/testuser/t2.md")
})

test("parameters are read in emission order, whatever that order is", () => {
  // The model does not always emit parameters in schema order — the captured
  // sample put content before filePath.
  const raw =
    "t\n</think>\n\n<tool_call>\n<function=write>\n<parameter=content>\nbody\n</parameter>\n<parameter=filePath>\n/tmp/a\n</parameter>\n</function>\n</tool_call>"
  const args = JSON.parse(translateContent(raw, schemas).toolCalls[0].function.arguments)
  assert.deepStrictEqual(args, { content: "body", filePath: "/tmp/a" })
})

test("non-streaming envelope preserves a nested marker end to end", () => {
  const payload = {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: NESTED_CLOSE_SAMPLE, reasoning_content: null, tool_calls: null },
        finish_reason: "stop",
      },
    ],
  }
  const out = rewriteNonStreaming(payload, schemas)
  const call = out.choices[0].message.tool_calls[0]
  assert.strictEqual(out.choices[0].finish_reason, "tool_calls")
  assert.strictEqual(
    JSON.parse(call.function.arguments).content,
    "The tag </parameter> ends a value and <tool_call> starts a call.",
  )
})

// --------------------------------------------------------------- quirk surface

test("transformRequest remaps unsupported reasoning_effort values", () => {
  // "high" returns HTTP 400 on this upstream; xhigh|medium|low are accepted.
  assert.strictEqual(quirk.transformRequest({ reasoning_effort: "high" }).reasoning_effort, "xhigh")
  assert.strictEqual(quirk.transformRequest({ reasoning_effort: "minimal" }).reasoning_effort, "low")
  assert.strictEqual(quirk.transformRequest({ reasoning_effort: "medium" }).reasoning_effort, "medium")
  assert.strictEqual(quirk.transformRequest({ reasoning_effort: "bogus" }).reasoning_effort, undefined)
  assert.deepStrictEqual(quirk.transformRequest({ model: "x" }), { model: "x" })
})

test("createStreamTranslator wires tool schemas from request context", () => {
  const tr = quirk.createStreamTranslator({ tools })
  tr.push("r</think>")
  tr.push("<tool_call><function=bash><parameter=timeout>\n900\n</parameter></function></tool_call>")
  const { toolCalls } = tr.finish()
  assert.strictEqual(toolCalls.length, 1)
  // Coerced to a number because the schema was available.
  assert.strictEqual(JSON.parse(toolCalls[0].function.arguments).timeout, 900)
})
