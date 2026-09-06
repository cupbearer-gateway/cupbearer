"use strict"
// DOC: ../docs/architecture.md → § Request profile
//
// Request profiler: infer what a request needs so the router can pick the
// cheapest leg that can actually serve it. Purely heuristic and synchronous —
// no LLM calls, no added latency, $0.
//
// The result feeds two separate router decisions:
//   - requiredTier   the quality ladder the task deserves (1 flagship .. 3 light)
//   - capabilities   hard features a leg must have (tools, vision, long-context)
//
// This is deliberately NOT an error classifier — that lives in classify.js.
// classify() reads a failed upstream response; profileRequest() reads the
// client's request before anything is sent.
//
// Tiers are a quality ladder, not a size class:
//   1  flagship   multi-step tool chains, heavy generation, big contexts —
//                 the requests where weak models fail visibly
//   2  standard   everyday chat and coding, single tool calls, routine work
//   3  light      short replies, simple transforms, classification-style asks
//
// Every bump below is a documented failure mode of small models, not a vibe:
// agentic loops (many tools / long history), long generation (max_tokens),
// and large inputs all degrade sharply on light models.

const LONG_CONTEXT_TOKENS = 64 * 1024

function contentLength(content) {
  if (!content) return 0
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const part of content) {
      if (typeof part === "string") n += part.length
      else if (part?.text) n += String(part.text).length
    }
    return n
  }
  return 0
}

// Rough token estimate: ~4 chars per token plus a small per-message overhead.
// Deliberately coarse — it only steers tier selection and the long-context
// flag; exact accounting stays with the provider's own usage report.
function estimateTokens(messages) {
  let chars = 0
  let count = 0
  for (const m of messages || []) {
    count++
    chars += contentLength(m?.content)
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / 4) + count * 8
}

/**
 * Profile a chat-completions payload.
 * @returns {{inputTokens:number, maxTokens:number|null, hasTools:boolean,
 *   toolCount:number, hasImages:boolean, taskType:string, requiredTier:number,
 *   capabilities:string[]}}
 */
function profileRequest(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const tools = Array.isArray(payload?.tools) ? payload.tools : []

  let hasImages = false
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (part?.type === "image_url" || part?.type === "image") hasImages = true
      }
    }
  }

  const maxTokens = typeof payload?.max_tokens === "number" && payload.max_tokens > 0 ? payload.max_tokens : null
  const inputTokens = estimateTokens(messages)

  // Hard capability requirements.
  const capabilities = []
  if (tools.length) capabilities.push("tools")
  if (hasImages) capabilities.push("vision")
  if (inputTokens >= LONG_CONTEXT_TOKENS) capabilities.push("long-context")

  // Quality tier. Ascending: anything stronger justifies the weaker bumps too.
  let requiredTier = 3
  if (tools.length || (maxTokens && maxTokens >= 2048) || inputTokens >= 12000) requiredTier = 2
  const agentic = tools.length >= 4 || (tools.length && messages.length >= 12)
  if (agentic || (maxTokens && maxTokens >= 8192) || (tools.length && inputTokens >= 32000)) requiredTier = 1

  const taskType = hasImages ? "vision" : tools.length ? "tools" : "chat"

  return { inputTokens, maxTokens, hasTools: tools.length > 0, toolCount: tools.length, hasImages, taskType, requiredTier, capabilities }
}

module.exports = { profileRequest, estimateTokens, LONG_CONTEXT_TOKENS }
