"use strict"
// DOC: ../../docs/quirks.md → § deepseek-tools

// Quirk: deepseek-tools
//
// For DeepSeek-family devshards reached through gonkarouter and vyce. These
// emit *native* OpenAI tool_calls, so qwen-xml does not apply — but the stream
// around those calls is defective in four separate ways, observed verbatim on
// gonkarouter/deepseek-ai/DeepSeek-V4-Flash-0731:
//
//   1. Chain of thought opens with "<think>" and NEVER closes. Everything after
//      it — including fabricated tool transcripts — sits in message.content with
//      reasoning_content null. think-tags treats an unterminated block as
//      reasoning, which is right, but it cannot do 2-4 below.
//
//   2. Control sentinels leak into content. Captured literal:
//        "</｜DSML｜tool_calls>"
//      (U+FF5C FULLWIDTH VERTICAL LINE, not an ASCII pipe). The DeepSeek family
//      also uses <｜tool▁calls▁begin｜> and Mistral-style [/INST].
//
//   3. The model HALLUCINATES the tool result and the turn that follows it,
//      inline, before the tool has run. Captured:
//        "<tool_result>\nprobe-raw\n</tool_result>"
//        "<result>\n; for 16-bit app support\n[fonts]...\n</result>\n\nThis
//         appears to be a standard Windows win.ini file..."
//      Left alone this becomes assistant text, so the agent reads a fabricated
//      transcript as if the tool had already answered.
//
//   4. Tool calls are DUPLICATED. "List the files in the current directory"
//      produced two identical calls, index 0 and index 1, both {"command":"ls -la"}.
//      opencode then runs the same side effect twice.
//
// It also handles PAIRED <think>...</think>, so it is a strict superset of
// think-tags for the providers it replaces it on (gonkarouter also serves
// MiniMax-M2.7 and Kimi-K2.6, which need the paired form).
//
// Rules 3 and the post-tool-call guard only arm for DeepSeek models, since
// dropping trailing prose is not safe for a well-behaved model. Suppressed
// text is routed to reasoning rather than discarded — surfaced, not swallowed.
//
// It also catches a sixth defect, specific to vyce but checked everywhere
// because the check is universally safe:
//
//   6. TRUNCATED tool-call arguments reported as success. vyce caps completion
//      at 4096 tokens no matter what max_tokens says (confirmed: max_tokens of
//      100, 4096, 6000 and absent all returned completion_tokens exactly 4096),
//      and when a tool call runs past that budget it truncates mid-JSON-string
//      while STILL sending finish_reason "tool_calls". The client gets
//        {"filePath": "C:/…/nova.html", "content": "<!DOCTYPE html>\n…
//      with no closing quote or brace, and reports
//        Invalid input for tool write: JSON parsing failed: Unterminated string
//      The same prompt on agentrouter and minimax returns 68k/58k of arguments
//      that parse cleanly, so this is a vyce ceiling, not a model limit.
//
// A tool call whose arguments are not valid JSON is useless to any client, so
// rather than forward it the translator reports the attempt as failed. The
// failure is scoped "request" and non-retryable on purpose: the cap is
// deterministic, so Cupbearer stops with a readable explanation instead of
// silently retrying or switching providers. Nothing ran, so the next turn can
// retry smaller or continue from where the output stopped.

const THINK_OPEN = "<think>"
const THINK_CLOSE = "</think>"

// Any tag containing U+FF5C, plus the Mistral instruction markers.
const SENTINEL_RE = /<\/?[^<>]*\uFF5C[^<>]*>|\[\/?INST\]/g

// Fabricated tool transcripts. The second group only arms for DeepSeek, because
// <result>/<output> can legitimately appear inside prose the model writes.
const FAKE_ALWAYS = ["tool_result", "tool_response", "tool_output"]
const FAKE_AGGRESSIVE = ["result", "output"]

// Longest sentinel we are willing to hold across a chunk boundary.
const MAX_TAG = 64

// How much leading assistant text to withhold before deciding it is a real prose
// answer rather than a preamble to a tool call.
//
// Why this exists: these models emit a token or two of chatter before the call
// ("I'll write that for you.", ".", " "). Flushing it commits the HTTP response,
// which forfeits the router's ability to fail over when the tool call that
// follows turns out to be truncated. Buffering the preamble keeps the response
// uncommitted through the whole tool-call decision. Observed preambles are under
// 60 chars, so this budget costs a plain prose answer at most 240 characters of
// latency before it starts streaming normally.
const PREAMBLE_BUDGET = 240

// A tool call is only usable if its arguments are valid JSON. At end of stream
// (or in a complete non-streaming body) anything else means the upstream stopped
// mid-emission — vyce does this at its 4096-token ceiling while still reporting
// finish_reason "tool_calls".
function argsAreUsable(args) {
  const s = String(args ?? "").trim()
  if (!s) return true // a genuinely empty argument list is normalised to {}
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

// Verdict for the router: the upstream ran out of output budget mid-call.
//
// Deliberately scoped "request" with retry off and the key left healthy:
//
//   - Not the key's fault. vyce answers smaller calls perfectly, so marking the
//     key degraded would eventually take a working provider out of rotation.
//   - Not worth retrying. The cap is deterministic; the same request will
//     truncate at the same place every time.
//   - So Cupbearer stops cleanly and hands back a readable explanation. Nothing
//     was written, no tool ran, and the next turn can retry with a smaller call
//     or continue where it left off.
function truncationError(calls) {
  const worst = calls.reduce((a, b) => (b.function.arguments.length > a.function.arguments.length ? b : a))
  const err = new Error(
    `this provider's output cap was reached before the "${worst.function.name}" call finished — ` +
      `its arguments stop mid-JSON after ${worst.function.arguments.length} characters, so the call was ` +
      `discarded and nothing ran. vyce caps every completion at 4096 tokens regardless of max_tokens. ` +
      `Retry with a smaller call (write the file in sections and append), or continue from where the ` +
      `output stopped.`,
  )
  err.cupbearerVerdict = {
    reason: "truncated_tool_call",
    keyState: "healthy",
    scope: "request",
    retry: false,
    // 422: the request was understood, but the provider could not produce a
    // usable result for it. Not a 5xx — nothing is broken.
    status: 422,
  }
  return err
}

function stripSentinels(s) {
  return s.replace(SENTINEL_RE, "")
}

function isDeepSeek(model) {
  return /deepseek/i.test(String(model ?? ""))
}

// Canonical dedupe key: same tool, same arguments, regardless of key order.
function callKey(name, args) {
  let canon = args
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      canon = JSON.stringify(Object.keys(parsed).sort().map((k) => [k, parsed[k]]))
    } else {
      canon = JSON.stringify(parsed)
    }
  } catch {
    canon = String(args).trim()
  }
  return `${name}\u0000${canon}`
}

// ------------------------------------------------------------- non-streaming

function translateContent(content, { aggressive }) {
  if (typeof content !== "string") return { reasoning: "", text: content ?? "" }

  const fake = aggressive ? [...FAKE_ALWAYS, ...FAKE_AGGRESSIVE] : FAKE_ALWAYS
  let reasoning = ""
  let text = ""
  let rest = stripSentinels(content)

  // Fabricated transcripts go to reasoning wherever they appear.
  for (const tag of fake) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, "g")
    rest = rest.replace(re, (_, inner) => {
      reasoning += inner
      return ""
    })
  }

  let i = 0
  while (i < rest.length) {
    const open = rest.indexOf(THINK_OPEN, i)
    if (open === -1) {
      text += rest.slice(i)
      break
    }
    text += rest.slice(i, open)
    const close = rest.indexOf(THINK_CLOSE, open + THINK_OPEN.length)
    if (close === -1) {
      // Unterminated: the remainder is monologue, not the answer.
      reasoning += rest.slice(open + THINK_OPEN.length)
      break
    }
    reasoning += rest.slice(open + THINK_OPEN.length, close)
    i = close + THINK_CLOSE.length
  }

  return { reasoning: reasoning.trim(), text: text.trim() }
}

function dedupe(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  const seen = new Map()
  for (const c of toolCalls) {
    const name = c?.function?.name
    if (!name) continue
    const args = c?.function?.arguments ?? "{}"
    const key = callKey(name, args)
    if (!seen.has(key)) seen.set(key, c)
  }
  return [...seen.values()]
}

// ----------------------------------------------------------------- streaming

class DeepSeekTranslator {
  constructor({ aggressive }) {
    this.aggressive = aggressive
    this.fakeTags = aggressive ? [...FAKE_ALWAYS, ...FAKE_AGGRESSIVE] : [...FAKE_ALWAYS]
    this.mode = "text" // text | think | fake
    this.fakeTag = null
    this.hold = ""
    this.pendingWs = ""
    this.emittedText = false
    // Leading text withheld until we know whether a tool call follows. See
    // PREAMBLE_BUDGET. Null once the preamble phase is over.
    this.preamble = ""
    this.preambleOpen = true
    // Tool-call accumulation, keyed by the upstream's stream index.
    this.byIndex = new Map()
    this.order = []
    this.sawToolCall = false
  }

  // Hold back a trailing unterminated tag so it is still recognised once the
  // rest of it arrives. Sentinel lengths vary, so this is bounded rather than
  // computed per-sentinel.
  static holdback(s) {
    const lt = s.lastIndexOf("<")
    if (lt !== -1 && s.indexOf(">", lt) === -1 && s.length - lt <= MAX_TAG) return s.length - lt
    const br = s.lastIndexOf("[")
    if (br !== -1 && s.indexOf("]", br) === -1 && s.length - br <= 8) return s.length - br
    return 0
  }

  emitText(out, s) {
    // After a tool call this model fabricates the rest of the turn; keep it
    // visible as reasoning instead of letting it become the answer.
    if (this.aggressive && this.sawToolCall) {
      if (s) out.push({ reasoning: s })
      return
    }
    // Withhold the opening text until it either exceeds the preamble budget
    // (so it is a real answer) or the stream ends. Flushing it early would
    // commit the HTTP response and forfeit failover on a truncated tool call.
    if (this.preambleOpen) {
      this.preamble += s
      if (this.preamble.length < PREAMBLE_BUDGET) return
      const held = this.preamble
      this.preamble = ""
      this.preambleOpen = false
      this.pushText(out, held)
      return
    }
    this.pushText(out, s)
  }

  // Whitespace-normalised text emission, matching the non-streaming path: no
  // leading blank lines, and trailing whitespace withheld so a "\n\n" that only
  // separates text from a tool call is dropped rather than emitted.
  pushText(out, s) {
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

  // Earliest interesting token in `buf` for the current mode.
  nextToken(buf) {
    let best = null
    const consider = (index, kind, length, tag) => {
      if (index === -1) return
      if (!best || index < best.index) best = { index, kind, length, tag }
    }

    if (this.mode === "fake") {
      const close = `</${this.fakeTag}>`
      consider(buf.indexOf(close), "fake-close", close.length, this.fakeTag)
      return best
    }

    if (this.mode === "think") consider(buf.indexOf(THINK_CLOSE), "think-close", THINK_CLOSE.length)
    else consider(buf.indexOf(THINK_OPEN), "think-open", THINK_OPEN.length)

    for (const tag of this.fakeTags) {
      const open = `<${tag}>`
      consider(buf.indexOf(open), "fake-open", open.length, tag)
    }

    SENTINEL_RE.lastIndex = 0
    const m = SENTINEL_RE.exec(buf)
    if (m) consider(m.index, "sentinel", m[0].length)

    return best
  }

  route(out, s) {
    if (!s) return
    if (this.mode === "think" || this.mode === "fake") out.push({ reasoning: s })
    else this.emitText(out, s)
  }

  push(delta) {
    if (!delta) return []
    const out = []
    let buf = this.hold + delta
    this.hold = ""

    for (;;) {
      const tok = this.nextToken(buf)
      if (!tok) break
      this.route(out, buf.slice(0, tok.index))
      buf = buf.slice(tok.index + tok.length)
      if (tok.kind === "think-open") {
        this.pendingWs = ""
        this.mode = "think"
      } else if (tok.kind === "think-close") {
        this.mode = "text"
      } else if (tok.kind === "fake-open") {
        this.pendingWs = ""
        this.fakeTag = tok.tag
        this.mode = "fake"
      } else if (tok.kind === "fake-close") {
        this.fakeTag = null
        // An unterminated <think> is still open around the fabricated block.
        this.mode = "think"
      }
      // "sentinel": consumed, nothing to change.
    }

    const keep = DeepSeekTranslator.holdback(buf)
    if (keep) {
      this.hold = buf.slice(buf.length - keep)
      buf = buf.slice(0, buf.length - keep)
    }
    this.route(out, buf)
    return out
  }

  // Accumulate native tool_call deltas instead of forwarding them, so the full
  // argument string exists before duplicates are collapsed. Returning an empty
  // array withholds; finish() emits the deduplicated set.
  pushToolCalls(deltas) {
    for (const d of deltas ?? []) {
      const index = d?.index ?? 0
      let rec = this.byIndex.get(index)
      if (!rec) {
        rec = { id: null, name: null, args: "" }
        this.byIndex.set(index, rec)
        this.order.push(index)
      }
      if (d?.id) rec.id = d.id
      if (d?.function?.name) rec.name = d.function.name
      if (typeof d?.function?.arguments === "string") rec.args += d.function.arguments
      if (rec.name) this.sawToolCall = true
    }
    return []
  }

  finish() {
    const out = []
    if (this.hold) {
      this.route(out, this.mode === "text" ? stripSentinels(this.hold) : this.hold)
      this.hold = ""
    }

    const collected = this.order
      .map((i) => this.byIndex.get(i))
      .filter((r) => r && r.name)
      .map((r) => ({
        id: r.id,
        type: "function",
        function: { name: r.name, arguments: r.args || "{}" },
      }))

    const unique = dedupe(collected)

    // Release the withheld preamble now that the tool-call outcome is known.
    // With a tool call in flight it was chatter ("I'll write that for you.") and
    // is dropped for DeepSeek models; with no call it was the real answer.
    if (this.preamble) {
      const held = this.preamble
      this.preamble = ""
      this.preambleOpen = false
      if (unique.length && this.aggressive) out.push({ reasoning: held })
      else this.pushText(out, held)
    }
    this.preambleOpen = false
    this.pendingWs = ""

    if (!unique.length) return { fragments: out, toolCalls: null }

    // Truncated arguments are worse than no answer: the client cannot parse them
    // and the tool never runs. Report it instead of forwarding a broken call.
    const broken = unique.filter((c) => !argsAreUsable(c.function.arguments))
    if (broken.length) return { fragments: out, toolCalls: null, error: truncationError(broken) }

    const toolCalls = unique.map((c, i) => ({
      index: i,
      id: c.id || `call_cupbearer_${i}`,
      type: "function",
      function: { name: c.function.name, arguments: c.function.arguments.trim() || "{}" },
    }))

    return { fragments: out, toolCalls }
  }
}

// ------------------------------------------------------------- quirk interface

module.exports = {
  id: "deepseek-tools",
  description:
    "For DeepSeek devshards with native tool_calls: routes bare/paired <think> to reasoning, strips ｜DSML｜ and [/INST] sentinels, keeps hallucinated <tool_result> transcripts out of the answer, and collapses duplicated tool calls.",

  transformResponse(payload, ctx) {
    const choices = payload?.choices
    if (!Array.isArray(choices)) return payload
    const aggressive = isDeepSeek(ctx?.model)
    for (const choice of choices) {
      const msg = choice?.message
      if (!msg) continue

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const unique = dedupe(msg.tool_calls)
        if (unique.length !== msg.tool_calls.length) msg.tool_calls = unique
        if (choice.finish_reason === "stop") choice.finish_reason = "tool_calls"

        // Same truncation guard as the streaming path. Throwing here is caught
        // by upstream.callJson and classified, so the router fails this leg over
        // instead of handing the client arguments it cannot parse.
        const broken = msg.tool_calls.filter((c) => !argsAreUsable(c?.function?.arguments))
        if (broken.length) throw truncationError(broken)
      }

      if (typeof msg.content !== "string") continue
      const { reasoning, text } = translateContent(msg.content, { aggressive })
      if (reasoning && !msg.reasoning_content) msg.reasoning_content = reasoning
      // With a tool call in flight, trailing prose from this model is fabricated.
      msg.content = aggressive && msg.tool_calls?.length ? text || null : text
    }
    return payload
  },

  createStreamTranslator(ctx) {
    return new DeepSeekTranslator({ aggressive: isDeepSeek(ctx?.model) })
  },

  _internals: {
    translateContent,
    DeepSeekTranslator,
    dedupe,
    stripSentinels,
    callKey,
    argsAreUsable,
    PREAMBLE_BUDGET,
  },
}
