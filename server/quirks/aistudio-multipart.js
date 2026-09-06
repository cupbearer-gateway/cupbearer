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

  if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    // Check both content and reasoning_content - both would create dual-field Parts
    const hasContentText = typeof msg.content === "string" && msg.content.trim()
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
    parts.push({ role: "assistant", tool_calls: msg.tool_calls })
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