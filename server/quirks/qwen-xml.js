"use strict"
// DOC: ../../docs/quirks.md → § qwen-xml

// Quirk: qwen-xml
//
// Ported from ~/.config/opencode/hcnapi-proxy.js. The upstream (api.hcnsec.cn,
// Qwen3.8-27B) accepts OpenAI-shaped requests but its responses are not
// OpenAI-shaped:
//
//   1. message.tool_calls is always null. Tool calls arrive as Qwen/Hermes XML
//      inside message.content:
//        <tool_call><function=NAME><parameter=KEY>\nVALUE\n</parameter></function></tool_call>
//   2. finish_reason is always "stop", never "tool_calls".
//   3. Chain-of-thought is prepended to content and terminated by a bare
//      "</think>" with no opening tag. reasoning_content is always null.
//
// Confirmed still true in Phase 0 probing: hcnapi returned
// tool_calls=null, reasoning=null, and XML in content.

const OPEN_TAG = "<tool_call>"
const CLOSE_TAG = "</tool_call>"
const THINK_END = "</think>"
const THINK_START = "<think>"
const REASONING_FLUSH_AT = 2000

let counter = 0
function callId() {
  counter = (counter + 1) % 100000
  return `call_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`
}

// Build { toolName: { paramName: schema } } so XML parameter strings can be
// coerced back to their declared JSON types.
function schemasFromTools(tools) {
  const out = {}
  if (!Array.isArray(tools)) return out
  for (const t of tools) {
    const fn = t?.function ?? t
    const name = fn?.name
    if (!name) continue
    out[name] = fn?.parameters?.properties ?? {}
  }
  return out
}

function coerce(raw, schema) {
  // The XML form wraps values in newlines: <parameter=k>\nVALUE\n</parameter>
  const s = String(raw).replace(/^\r?\n/, "").replace(/\r?\n$/, "")
  const type = schema?.type
  if (type === "string") return s
  const trimmed = s.trim()
  if (type === "number" || type === "integer") {
    const n = Number(trimmed)
    return trimmed !== "" && Number.isFinite(n) ? n : s
  }
  if (type === "boolean") {
    if (/^true$/i.test(trimmed)) return true
    if (/^false$/i.test(trimmed)) return false
    return s
  }
  if (type === "array" || type === "object") {
    try {
      return JSON.parse(trimmed)
    } catch {
      return s
    }
  }
  // Unknown/absent schema: only reinterpret when it is unambiguously JSON.
  if (/^[[{]/.test(trimmed) || /^(true|false|null)$/.test(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return s
    }
  }
  return s
}

function fromJsonBody(text) {
  const start = text.indexOf("{")
  if (start === -1) return null
  let obj
  try {
    obj = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1))
  } catch {
    return null
  }
  const name = obj?.name ?? obj?.function?.name ?? obj?.tool ?? obj?.tool_name
  if (!name) return null
  let args = obj?.arguments ?? obj?.parameters ?? obj?.function?.arguments ?? {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      args = { input: args }
    }
  }
  return { name, args: args && typeof args === "object" ? args : {} }
}

const PARAM_CLOSE = "</parameter>"
const PARAM_OPEN_TOKEN = "<parameter="

// What legitimately follows a real </parameter>: another parameter, the end of
// the function block, or the end of the tool call. Anything else means the
// </parameter> we just found is literal text inside the value.
const AFTER_PARAM_CLOSE =
  /^\s*(?:<parameter\s*=|<\/function\s*>|<\/tool_call\s*>|<tool_call\s*>|<function\s*=|$)/

// End of the value that starts at `from`. Returns the value and the cursor just
// past its closing tag.
//
// Parameter values are arbitrary strings, so every marker the parser looks for
// can legitimately appear inside one. Two real cases, both captured from
// hcnapi/Qwen3.8-27B:
//
//   1. A bare mention. "The tag </parameter> ends a value and <tool_call>
//      starts a call." A non-greedy match stops at that </parameter> and
//      truncates the value to "The tag " — valid JSON, corrupted file, no error.
//      Rejected by AFTER_PARAM_CLOSE: real structure never follows.
//
//   2. A complete nested example. Documentation that quotes a whole tool call
//      contains a </parameter> which IS followed by </function>, so the lookahead
//      alone would accept it. Rejected by depth: the nested <parameter= opened
//      first, so that close belongs to it.
//
// Neither test is sufficient alone; together they cover every shape observed.
function findParamEnd(s, from) {
  let depth = 0 // <parameter= tags opened inside this value
  let lastCandidate = -1
  let i = from

  for (;;) {
    const close = s.indexOf(PARAM_CLOSE, i)
    if (close === -1) break

    // Any nested parameter opening before this close belongs to the value.
    let scan = i
    for (;;) {
      const open = s.indexOf(PARAM_OPEN_TOKEN, scan)
      if (open === -1 || open > close) break
      depth++
      scan = open + PARAM_OPEN_TOKEN.length
    }

    if (depth > 0) {
      // Closes a nested <parameter=..>, not ours.
      depth--
      i = close + PARAM_CLOSE.length
      continue
    }

    lastCandidate = close
    if (AFTER_PARAM_CLOSE.test(s.slice(close + PARAM_CLOSE.length))) {
      return { value: s.slice(from, close), next: close + PARAM_CLOSE.length }
    }
    i = close + PARAM_CLOSE.length
  }

  // No close satisfied both tests. Fall back to the last balanced candidate;
  // failing that the stream was cut off mid-value, so keep what we have rather
  // than dropping it.
  if (lastCandidate !== -1) {
    return { value: s.slice(from, lastCandidate), next: lastCandidate + PARAM_CLOSE.length }
  }
  return { value: s.slice(from), next: s.length }
}

const PARAM_OPEN_ANCHORED = /^\s*<parameter\s*=\s*([^>\n]+?)\s*>/
const PARAM_OPEN_LOOSE = /<parameter\s*=\s*([^>\n]+?)\s*>/
const FN_CLOSE_ANCHORED = /^\s*<\/function\s*>/

// Read one <function=..> block's parameters, starting just after its open tag.
//
// Parameters are read positionally rather than by a global regex scan: the
// cursor jumps over each value, so a literal <parameter=..> or </function>
// inside a value can never be mistaken for structure.
function parseParams(s, from, props) {
  const args = {}
  let found = false
  let pos = from

  for (;;) {
    const ahead = s.slice(pos)

    const fnClose = FN_CLOSE_ANCHORED.exec(ahead)
    if (fnClose) {
      pos += fnClose[0].length
      break
    }

    // Anchored once we are in the block. Before the first parameter, tolerate
    // junk between the function open and the parameter (the upstream has always
    // emitted a bare newline, but this costs nothing).
    let m = PARAM_OPEN_ANCHORED.exec(ahead)
    if (!m && !found) {
      const loose = PARAM_OPEN_LOOSE.exec(ahead)
      // Only if it really is before the end of this block.
      const fnEnd = ahead.indexOf("</function")
      if (loose && (fnEnd === -1 || loose.index < fnEnd)) m = loose
    }
    if (!m) break

    found = true
    const key = m[1].trim().replace(/^["']|["']$/g, "")
    const valueStart = pos + (m.index ?? 0) + m[0].length
    const { value, next } = findParamEnd(s, valueStart)
    args[key] = coerce(value, props[key])
    pos = next
  }

  return { args, found, next: pos }
}

const FN_OPEN = /<function\s*=\s*([^>\s]+)\s*>/

// Parse every <function=..> block in `region`, in order.
function parseBlock(region, schemas) {
  const out = []
  let pos = 0

  for (;;) {
    const m = FN_OPEN.exec(region.slice(pos))
    if (!m) break

    const name = m[1].trim().replace(/^["']|["']$/g, "")
    const props = schemas[name] ?? {}
    const start = pos + m.index + m[0].length

    const { args, found, next } = parseParams(region, start, props)
    if (found) {
      pos = next
    } else {
      // No XML parameters: the block may hold a bare JSON object instead.
      const close = region.indexOf("</function", start)
      const innerEnd = close === -1 ? region.length : close
      const j = fromJsonBody(region.slice(start, innerEnd))
      if (j) Object.assign(args, j.args)
      pos = innerEnd + 1
    }
    out.push({ name, args })
  }

  return out
}

// Every tool call in the region following the first <tool_call>.
//
// The region is scanned as a whole rather than split on </tool_call> first: that
// tag can also appear inside a parameter value, and splitting on it truncated
// the call. parseBlock skips over value text, so the markers themselves are
// simply ignored.
function parseCalls(region, schemas) {
  const xml = parseBlock(region, schemas)
  if (xml.length) return xml

  // No XML function blocks at all — try the bare-JSON tool_call variant.
  const out = []
  const blockRe = new RegExp(`${OPEN_TAG}([\\s\\S]*?)(?:${CLOSE_TAG}|$)`, "g")
  let m
  while ((m = blockRe.exec(region))) {
    const j = fromJsonBody(m[1])
    if (j) out.push(j)
  }
  if (!out.length) {
    const j = fromJsonBody(region)
    if (j) out.push(j)
  }
  return out
}

function toOpenAiToolCalls(parsed) {
  return parsed.map((c, i) => ({
    index: i,
    id: callId(),
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
  }))
}

// Split raw model content into { reasoning, text, toolCalls }.
function translateContent(content, schemas) {
  let rest = typeof content === "string" ? content : ""
  let reasoning = ""

  const end = rest.indexOf(THINK_END)
  if (end !== -1) {
    reasoning = rest.slice(0, end)
    rest = rest.slice(end + THINK_END.length)
    const open = reasoning.indexOf(THINK_START)
    if (open !== -1) reasoning = reasoning.slice(open + THINK_START.length)
  }

  let parsed = []
  const first = rest.indexOf(OPEN_TAG)
  if (first !== -1) {
    parsed = parseCalls(rest.slice(first), schemas)
    rest = rest.slice(0, first)
  }

  return {
    reasoning: reasoning.trim(),
    text: rest.trim(),
    toolCalls: toOpenAiToolCalls(parsed),
  }
}

// A tiny state machine over content deltas.
//
//   THINKING -> (sees "</think>") -> TEXT -> (sees "<tool_call>") -> TOOL
//
// While THINKING, deltas are re-emitted as reasoning so the AI SDK treats them
// as reasoning rather than assistant text. While TEXT, deltas pass through.
// Once a tool call starts, text output stops and the buffered XML is parsed at
// end-of-stream, emitted as a single tool_calls delta plus finish_reason
// "tool_calls".
//
// Emitting tool_calls at the end (rather than incrementally) is deliberate: the
// arguments only become valid JSON once each </parameter> is closed, and the AI
// SDK concatenates argument deltas verbatim.
class StreamTranslator {
  constructor(schemas) {
    this.schemas = schemas
    this.state = "THINKING"
    this.hold = "" // partial tag guard for pass-through states
    this.toolBuf = "" // raw XML once a tool call has begun
    this.reasoning = "" // reasoning accumulated before flush
    this.pendingWs = "" // trailing whitespace withheld until more text arrives
    this.emittedText = false
    this.sawTool = false
    this.sawAnyContent = false
  }

  // Longest suffix of `s` that is a proper prefix of any sentinel — those bytes
  // must be held back so a tag split across chunks is still recognised.
  static holdback(s) {
    const sentinels = [THINK_END, OPEN_TAG]
    let keep = 0
    for (const tag of sentinels) {
      const max = Math.min(tag.length - 1, s.length)
      for (let n = max; n > keep; n--) {
        if (s.slice(s.length - n) === tag.slice(0, n)) {
          keep = n
          break
        }
      }
    }
    return keep
  }

  // Emit assistant text with the same whitespace shape the non-streaming path
  // produces: no leading blank lines after </think>, and trailing whitespace
  // withheld so a "\n\n" that only separates text from <tool_call> is dropped.
  emitText(out, s) {
    let chunk = this.pendingWs + s
    this.pendingWs = ""
    if (!this.emittedText) chunk = chunk.replace(/^\s+/, "")
    if (!chunk) return
    const m = chunk.match(/\s+$/)
    if (m) {
      this.pendingWs = m[0]
      chunk = chunk.slice(0, chunk.length - m[0].length)
    }
    if (!chunk) return
    this.emittedText = true
    out.push({ text: chunk })
  }

  // Returns [{ reasoning }|{ text }] fragments for this delta.
  push(delta) {
    if (!delta) return []
    this.sawAnyContent = true
    const out = []

    if (this.state === "TOOL") {
      this.toolBuf += delta
      return out
    }

    let buf = this.hold + delta
    this.hold = ""

    while (buf) {
      if (this.state === "THINKING") {
        const i = buf.indexOf(THINK_END)
        if (i !== -1) {
          this.reasoning += buf.slice(0, i)
          buf = buf.slice(i + THINK_END.length)
          const flush = this.reasoning.replace(/^\s*<think>/, "")
          if (flush.trim()) out.push({ reasoning: flush })
          this.reasoning = ""
          this.state = "TEXT"
          continue
        }
        const keep = StreamTranslator.holdback(buf)
        this.reasoning += keep ? buf.slice(0, buf.length - keep) : buf
        this.hold = keep ? buf.slice(buf.length - keep) : ""
        // Stream long reasoning out in chunks so the UI is not frozen.
        if (this.reasoning.length >= REASONING_FLUSH_AT) {
          const flush = this.reasoning.replace(/^\s*<think>/, "")
          if (flush) out.push({ reasoning: flush })
          this.reasoning = ""
        }
        return out
      }

      // state === TEXT
      const i = buf.indexOf(OPEN_TAG)
      if (i !== -1) {
        const before = buf.slice(0, i)
        if (before) this.emitText(out, before)
        this.pendingWs = "" // whitespace before a tool call is separator, not output
        this.toolBuf = buf.slice(i)
        this.state = "TOOL"
        this.sawTool = true
        return out
      }
      const keep = StreamTranslator.holdback(buf)
      const emit = keep ? buf.slice(0, buf.length - keep) : buf
      if (emit) this.emitText(out, emit)
      this.hold = keep ? buf.slice(buf.length - keep) : ""
      return out
    }

    return out
  }

  // Final fragments plus the tool_calls array (if any) at end of stream.
  finish() {
    const out = []
    if (this.state === "THINKING") {
      // Stream ended without "</think>" — treat what we have as reasoning.
      const leftover = (this.reasoning + this.hold).replace(/^\s*<think>/, "")
      if (leftover.trim()) out.push({ reasoning: leftover })
      this.reasoning = ""
      this.hold = ""
    } else if (this.state === "TEXT") {
      if (this.hold) this.emitText(out, this.hold)
      this.hold = ""
      this.pendingWs = ""
    }

    let toolCalls = null
    if (this.sawTool && this.toolBuf) {
      const parsed = parseCalls(this.toolBuf, this.schemas)
      if (parsed.length) toolCalls = toOpenAiToolCalls(parsed)
      else out.push({ text: this.toolBuf }) // unparseable: surface rather than swallow
    }
    return { fragments: out, toolCalls }
  }
}

function rewriteNonStreaming(payload, schemas) {
  const choices = payload?.choices
  if (!Array.isArray(choices)) return payload
  for (const choice of choices) {
    const msg = choice?.message
    if (!msg) continue
    // Already conformant (upstream may fix this someday): leave alone.
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (choice.finish_reason === "stop") choice.finish_reason = "tool_calls"
      continue
    }
    const { reasoning, text, toolCalls } = translateContent(msg.content, schemas)
    if (reasoning) msg.reasoning_content = reasoning
    if (toolCalls.length) {
      msg.content = text || null
      msg.tool_calls = toolCalls.map(({ index, ...rest }) => rest)
      choice.finish_reason = "tool_calls"
    } else {
      msg.content = text
    }
  }
  return payload
}

// ------------------------------------------------------------- quirk interface

const VALID_EFFORT = new Set(["xhigh", "medium", "low"])
const EFFORT_MAP = {
  high: "xhigh",
  max: "xhigh",
  xhigh: "xhigh",
  medium: "medium",
  low: "low",
  minimal: "low",
  none: "low",
}

module.exports = {
  id: "qwen-xml",
  description:
    "Translates Qwen/Hermes XML tool calls and bare </think> reasoning in message.content into real OpenAI tool_calls and reasoning_content.",

  // reasoning_effort "high" returns HTTP 400 on this upstream.
  transformRequest(body) {
    if (body?.reasoning_effort !== undefined) {
      const mapped = EFFORT_MAP[String(body.reasoning_effort).toLowerCase()]
      if (mapped) body.reasoning_effort = mapped
      else if (!VALID_EFFORT.has(body.reasoning_effort)) delete body.reasoning_effort
    }
    return body
  },

  transformResponse(payload, ctx) {
    return rewriteNonStreaming(payload, schemasFromTools(ctx?.tools))
  },

  createStreamTranslator(ctx) {
    return new StreamTranslator(schemasFromTools(ctx?.tools))
  },

  // exported for tests
  _internals: { translateContent, StreamTranslator, rewriteNonStreaming, schemasFromTools, parseCalls, findParamEnd },
}
