"use strict"
// DOC: ../../docs/quirks.md → § The quirk interface

// Quirk: aistudio-think-sig
//
// For the `aistudio` provider (local AIStudio2API on 127.0.0.1:2048). Google's
// Gemini 3.x models attach a per-call *thought signature* to every function
// call: an opaque token certifying that the call really came out of a model
// reasoning chain. The token must be echoed back on that same function call in
// the next request or Google rejects it. AIStudio2API streams it on the tool
// call as `extra_content.google.thought_signature` (protocol doc:
// "OpenAI Chat | assistant tool call 的 extra_content.google.thought_signature
// | tool call 的同名扩展字段"), and its inbound encoder reads it back from the
// same place — openai.go populates Part.ThoughtSignature from
// call.ExtraContent.Google.ThoughtSignature.
//
// The failure this quirk fixes (captured verbatim from ZCode on gemini-flash):
//
//   AI Studio GenerateContent 返回 HTTP 400、协议错误码 3: [original:
//   beyond::dependency::INVALID_ARGUMENT] Function call is missing a thought
//   signature. (qos=CRITICAL_PLUS)
//
// Cause: ZCode keeps the assistant tool call in its own message history but
// drops the extra_content extension it did not originate, so the round-trip
// request echoes the call without its signature. Empirically (probed directly
// against AIStudio2API): a tool result alone is not enough — attaching the
// signature to the tool message is also rejected — but restoring it onto the
// assistant's tool_calls entry makes the same history pass.
//
// Fix: cache every thought signature that flows through Cupbearer from this
// provider (SSE chunk on the streamed path, message.tool_calls on the
// non-streamed path), then in transformRequest restore the missing signature
// onto every assistant tool_call that matches a cached id. Re-injection is
// idempotent: a client that does preserve the extension is left untouched, and
// a cached signature is applied to every request that carries the call, which
// is what makes multi-turn tool chains keep working (each turn re-encodes the
// whole history).

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_ENTRIES = 512

// id -> { sig, name, at }  (module state; quirk instances are process singletons)
const cache = new Map()

function prune(now) {
  for (const [id, e] of cache) {
    if (now - e.at > CACHE_TTL_MS) cache.delete(id)
  }
  if (cache.size > MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [id] of sorted.slice(0, cache.size - MAX_ENTRIES)) cache.delete(id)
  }
}

function signatureOf(toolCall) {
  return toolCall && toolCall.extra_content && toolCall.extra_content.google
    ? toolCall.extra_content.google.thought_signature
    : ""
}

function remember(toolCall) {
  const sig = signatureOf(toolCall)
  const name = toolCall.function?.name || ""
  // An entry worth having carries a signature or a name; a bare id would only
  // let restore() inject an empty signature.
  if (!toolCall.id || (!sig && !name)) return
  prune(Date.now())
  const existing = cache.get(toolCall.id) || {}
  cache.set(toolCall.id, {
    sig: sig || existing.sig || "",
    name: name || existing.name || "",
    at: Date.now(),
  })
}

function restore(message) {
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : null
  if (!calls) return message
  let changed = false
  const next = calls.map((call) => {
    if (call.id && !signatureOf(call)) {
      const hit = cache.get(call.id)
      if (hit) {
        changed = true
        return { ...call, extra_content: { google: { thought_signature: hit.sig } } }
      }
    }
    return call
  })
  return changed ? { ...message, tool_calls: next } : message
}

function restoreToolResult(message) {
  if (!message || message.role !== "tool") return message
  const toolCallId = message.tool_call_id
  if (!toolCallId) return message
  const hit = cache.get(toolCallId)
  let funcName = hit?.name
  if (!funcName) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "")
    if (content.includes("Bash") || content.includes("bash")) funcName = "Bash"
    else if (content.includes("Edit") || content.includes("edit")) funcName = "Edit"
    else if (content.includes("Read") || content.includes("read")) funcName = "Read"
    else if (content.includes("Write") || content.includes("write")) funcName = "Write"
    else if (content.includes("Glob") || content.includes("glob")) funcName = "Glob"
    else if (content.includes("Grep") || content.includes("grep")) funcName = "Grep"
    else if (content.includes("Todo") || content.includes("todo")) funcName = "TodoWrite"
    else funcName = "function"
  }
  return { ...message, name: funcName, extra_content: { google: { function_name: funcName } } }
}

function primeCacheFromHistory(messages) {
  if (!Array.isArray(messages)) return
  for (const m of messages) {
    if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        if (call.id && call.function?.name) {
          const existing = cache.get(call.id) || {}
          if (!existing.name) {
            cache.set(call.id, {
              sig: existing.sig || "",
              name: call.function.name,
              at: Date.now(),
            })
          }
        }
      }
    }
  }
}

module.exports = {
  id: "aistudio-think-sig",
  description:
    "For the local AI Studio gateway: Gemini 3.x demands its per-call thought signature be echoed on every function call, and clients like ZCode strip it (400 'Function call is missing a thought signature'). Also, AIStudio2API's conversation compression can drop the tool_call_id from tool result messages, causing 'function result missing name and cannot resolve by call ID' when AI Studio's encoder can't match the result to a call. This quirk caches function names alongside thought signatures and re-injects them onto tool result messages so the functionResponse encoding always has a name to fall back on.",

  transformResponse(payload) {
    const calls = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.tool_calls
      : null
    if (Array.isArray(calls)) for (const c of calls) remember(c)
    return payload
  },

  // Passthrough path: every SSE line crosses this hook before being written to
  // the client. Peek at tool-call deltas for the signature and let them through.
  filterStreamLine(line) {
    const t = String(line).trim()
    if (!t.startsWith("data:")) return true
    const data = t.slice(5).trim()
    if (data === "[DONE]" || data === "null") return true
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch {
      return true
    }
    const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta
    const calls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : null
    if (calls) for (const c of calls) remember(c)
    return true
  },

  transformRequest(body) {
    const messages = body && Array.isArray(body.messages) ? body.messages : null
    if (!messages) return body
    primeCacheFromHistory(messages)
    let changed = false
    const next = messages.map((m) => {
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
        const restored = restore(m)
        if (restored !== m) changed = true
        return restored
      }
      if (m && m.role === "tool") {
        const restored = restoreToolResult(m)
        if (restored !== m) changed = true
        return restored
      }
      return m
    })
    return changed ? { ...body, messages: next } : body
  },

  _internals: { cache, signatureOf, remember, restore, restoreToolResult, primeCacheFromHistory },
}
