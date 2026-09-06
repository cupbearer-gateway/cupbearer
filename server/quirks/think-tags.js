"use strict"
// DOC: ../../docs/quirks.md → § think-tags

// Quirk: think-tags
//
// Some models emit chain-of-thought inside paired <think>...</think> tags in
// message.content and leave reasoning_content null. opencode then renders the
// entire monologue as the assistant's answer.
//
// Observed in Phase 1 verification:
//   minimax/MiniMax-M2.7             "<think>\nThe user asks...\n</think>\n\n4"
//   gonkarouter/moonshotai/Kimi-K2.6 "<think>The user says \"hi\"..."
//
// Distinct from qwen-xml, which handles a BARE closing </think> with no opening
// tag and also parses XML tool calls. This quirk only relocates paired-tag
// reasoning into reasoning_content, and leaves tool calls alone because these
// providers already return native OpenAI tool_calls.

const OPEN = "<think>"
const CLOSE = "</think>"

// Pull every <think>…</think> block out of `text`.
function split(text) {
  if (typeof text !== "string" || !text.includes(OPEN)) return { reasoning: "", text: text ?? "" }

  let reasoning = ""
  let out = ""
  let i = 0
  while (i < text.length) {
    const open = text.indexOf(OPEN, i)
    if (open === -1) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, open)
    const close = text.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) {
      // Unterminated: treat the remainder as reasoning rather than leaking it.
      reasoning += text.slice(open + OPEN.length)
      i = text.length
      break
    }
    reasoning += text.slice(open + OPEN.length, close)
    i = close + CLOSE.length
  }
  return { reasoning: reasoning.trim(), text: out.trim() }
}

// Streaming state machine. Tags can be split across chunk boundaries, so the
// longest partial-tag suffix is held back until the next delta arrives.
class ThinkTagTranslator {
  constructor() {
    this.inThink = false
    this.hold = ""
    this.emittedText = false
    this.pendingWs = ""
  }

  static holdback(s, inThink) {
    const tag = inThink ? CLOSE : OPEN
    const max = Math.min(tag.length - 1, s.length)
    for (let n = max; n > 0; n--) {
      if (s.slice(s.length - n) === tag.slice(0, n)) return n
    }
    return 0
  }

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

  push(delta) {
    if (!delta) return []
    const out = []
    let buf = this.hold + delta
    this.hold = ""

    while (buf) {
      if (this.inThink) {
        const close = buf.indexOf(CLOSE)
        if (close !== -1) {
          const piece = buf.slice(0, close)
          if (piece) out.push({ reasoning: piece })
          buf = buf.slice(close + CLOSE.length)
          this.inThink = false
          continue
        }
        const keep = ThinkTagTranslator.holdback(buf, true)
        const emit = keep ? buf.slice(0, buf.length - keep) : buf
        if (emit) out.push({ reasoning: emit })
        this.hold = keep ? buf.slice(buf.length - keep) : ""
        return out
      }

      const open = buf.indexOf(OPEN)
      if (open !== -1) {
        const before = buf.slice(0, open)
        if (before) this.emitText(out, before)
        this.pendingWs = "" // whitespace before a think block is a separator
        buf = buf.slice(open + OPEN.length)
        this.inThink = true
        continue
      }
      const keep = ThinkTagTranslator.holdback(buf, false)
      const emit = keep ? buf.slice(0, buf.length - keep) : buf
      if (emit) this.emitText(out, emit)
      this.hold = keep ? buf.slice(buf.length - keep) : ""
      return out
    }
    return out
  }

  finish() {
    const out = []
    if (this.hold) {
      if (this.inThink) out.push({ reasoning: this.hold })
      else this.emitText(out, this.hold)
      this.hold = ""
    }
    this.pendingWs = ""
    // No tool-call rewriting: these providers emit native tool_calls already.
    return { fragments: out, toolCalls: null }
  }
}

module.exports = {
  id: "think-tags",
  description:
    "Moves paired <think>...</think> chain-of-thought out of message.content into reasoning_content, so it renders as reasoning instead of as the answer.",

  transformResponse(payload) {
    const choices = payload?.choices
    if (!Array.isArray(choices)) return payload
    for (const choice of choices) {
      const msg = choice?.message
      if (!msg || typeof msg.content !== "string") continue
      const { reasoning, text } = split(msg.content)
      if (!reasoning) continue
      // Never clobber reasoning the upstream already supplied.
      if (!msg.reasoning_content) msg.reasoning_content = reasoning
      msg.content = text
    }
    return payload
  },

  createStreamTranslator() {
    return new ThinkTagTranslator()
  },

  _internals: { split, ThinkTagTranslator },
}
