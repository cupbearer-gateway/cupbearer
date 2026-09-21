"use strict"

const CONTENT_FIELDS = ["text", "inlineData", "fileData", "functionCall", "functionResponse"]

function countContentFields(part) {
  return CONTENT_FIELDS.filter((f) => part[f] !== undefined && part[f] !== null).length
}

function singleField(part) {
  for (const f of CONTENT_FIELDS) {
    if (part[f] !== undefined && part[f] !== null) return f
  }
  return null
}

function sanitizePart(part) {
  const count = countContentFields(part)
  if (count <= 1) return part
  const first = singleField(part)
  const cleaned = { [first]: part[first] }
  return cleaned
}

function isBlankText(v) {
  return typeof v !== "string" || !v.trim()
}

function cleanedArrayContent(content) {
  if (!Array.isArray(content)) return content
  const kept = content.filter((block) => {
    if (block == null) return false
    if (typeof block === "string") return block.trim().length > 0
    if (typeof block !== "object") return false
    const t = block.type || ""
    if (t === "text" || t === "input_text" || t === "output_text") {
      return typeof block.text === "string" ? block.text.trim().length > 0 : false
    }
    // keep image/file/audio/video blocks as-is
    return true
  })
  return kept
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== "object") return msg

  const role = msg.role

  if (role === "tool") {
    const part = {}
    if (typeof msg.content === "string" && msg.content) {
      part.text = msg.content
    } else if (msg.content) {
      part.text = typeof msg.content === "object" ? JSON.stringify(msg.content) : String(msg.content)
    }
    // Preserve tool_call_id and name for Google API functionResponse encoding
    const result = { role: "tool", content: part.text || "" }
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id
    if (msg.name) result.name = msg.name
    return result
  }

  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0

  // Normalize array content: drop empty text blocks (they become Part{Text:""}
  // which AIStudio2API encodes as 0 variants -> 400 'part must have exactly
  // one content type', e.g. "content 250 part 0").
  if (Array.isArray(msg.content)) {
    const kept = cleanedArrayContent(msg.content)
    if (kept.length !== msg.content.length) {
      if (kept.length === 0 && !hasToolCalls) return null // drop empty message
      if (kept.length === 0 && hasToolCalls) {
        const { content: _dropped, ...rest } = msg
        return rest // tool_calls-only, no empty text part
      }
      return { ...msg, content: kept }
    }
  }

  // Empty-string / whitespace content with tool_calls: strip content so the
  // message encodes as tool_calls-only instead of [empty-text, tool_call].
  // Empty-string content without tool_calls: drop (it would encode as
  // Part{Text:""} -> variants==0 -> same 400).
  if (typeof msg.content === "string" && !msg.content.trim()) {
    if (hasToolCalls) {
      const { content: _dropped, ...rest } = msg
      return rest
    }
    if (role === "assistant" || role === "user") return null
    return msg
  }

  if (role === "assistant" && hasToolCalls) {
    // Check both content and reasoning_content - both would create dual-field Parts.
    // Content may be string or array at this point (empty cases handled above).
    const hasContentText =
      (typeof msg.content === "string" && msg.content.trim().length > 0) ||
      (Array.isArray(msg.content) && msg.content.length > 0)
    const hasReasoningText = typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()
    if (!hasContentText && !hasReasoningText) {
      return msg
    }
    // Split into separate messages: one with content/reasoning, one with tool_calls
    const parts = []
    if (hasContentText) {
      parts.push({ role: "assistant", content: msg.content })
    }
    if (hasReasoningText) {
      parts.push({ role: "assistant", content: msg.reasoning_content })
    }
    const toolOnly = { role: "assistant", tool_calls: msg.tool_calls }
    if (msg.name) toolOnly.name = msg.name
    parts.push(toolOnly)
    return parts
  }

  return msg
}

module.exports = {
  id: "aistudio-multipart",
  description:
    "For the local AI Studio gateway (AIStudio2API at 127.0.0.1:2048): AI Studio's protobuf encoder rejects a Part that has more than one content field set (text, inlineData, functionCall, functionResponse, fileData) — a non-retryable 400 'part must have exactly one content type'. This happens after AIStudio2API's conversation compression when it incorrectly merges messages, creating a Part with multiple content types. Also guards against assistant messages that carry both text and tool_calls simultaneously, which AIStudio2API encodes as a dual-field Part.",

  transformRequest(body) {
    const messages = body && Array.isArray(body.messages) ? body.messages : null
    if (!messages) return body

    let changed = false
    const next = []

    for (const msg of messages) {
      const sanitized = sanitizeMessage(msg)
      if (sanitized === null) {
        changed = true // drop empty-text message that would 400 downstream
        continue
      }
      if (Array.isArray(sanitized)) {
        next.push(...sanitized)
        changed = true
      } else if (sanitized !== msg) {
        next.push(sanitized)
        changed = true
      } else {
        next.push(msg)
      }
    }

    return changed ? { ...body, messages: next } : body
  },

  _internals: { sanitizePart, sanitizeMessage, CONTENT_FIELDS },
}