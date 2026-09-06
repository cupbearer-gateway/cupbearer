"use strict"
// DOC: ../docs/api.md → § Anthropic-compatible surface
//
// POST /v1/messages — the Anthropic Messages API, translated onto the same
// router every other client uses. This is what makes Cupbearer a drop-in for
// Claude Code (ANTHROPIC_BASE_URL=…) without any shim process.
//
// Supported: system prompts, text + image content blocks, tool definitions,
// tool_use / tool_result round trips, stop_reason mapping, usage mapping, and
// the streaming event sequence (message_start → content_block_* →
// message_delta → message_stop).
//
// Mechanics: the request is dispatched through the router as a normal
// non-streaming completion (a buffered capture, so failover and the quality
// gate apply unchanged), and the full result is then either returned as JSON
// or replayed as the Anthropic SSE event sequence. Streaming therefore buys no
// time-to-first-byte on this surface — documented, and fine for agent use.

const config = require("./config")
const router = require("./router")
const { json, error, readJsonBody } = require("./http-util")

// ---------------------------------------------------------------- request map

function contentBlocksToOpenAI(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text })
    } else if (block?.type === "image" && block?.source?.type === "base64") {
      out.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    } else if (block?.type === "tool_result") {
      // Anthropic puts tool results in user-role blocks; OpenAI wants a
      // separate tool-role message per call.
      const inner = Array.isArray(block.content)
        ? block.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
        : typeof block.content === "string"
          ? block.content
          : ""
      out.push({ __toolResult: { tool_use_id: block.tool_use_id, content: inner } })
    }
  }
  return out
}

function messagesToOpenAI(anthropicMessages, system) {
  const messages = []
  if (system) {
    const text = typeof system === "string" ? system : (system || []).filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    if (text) messages.push({ role: "system", content: text })
  }
  for (const m of anthropicMessages || []) {
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      // Assistant blocks may mix text and tool_use.
      const text = m.content.filter((b) => b?.type === "text").map((b) => b.text).join("")
      const calls = m.content.filter((b) => b?.type === "tool_use")
      const message = { role: "assistant", content: text || null }
      if (calls.length) {
        message.tool_calls = calls.map((c, i) => ({
          id: c.id || `call_${i}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }))
      }
      messages.push(message)
      continue
    }
    const blocks = contentBlocksToOpenAI(m?.content)
    const toolResults = blocks.filter((b) => b.__toolResult)
    const rest = blocks.filter((b) => !b.__toolResult)
    if (toolResults.length) {
      for (const tr of toolResults) {
        messages.push({ role: "tool", tool_call_id: tr.__toolResult.tool_use_id, content: tr.__toolResult.content })
      }
    }
    if (rest.length) {
      messages.push({
        role: m?.role === "assistant" ? "assistant" : "user",
        content: rest.length === 1 && rest[0].type === "text" ? rest[0].text : rest,
      })
    }
    if (!toolResults.length && !rest.length) {
      messages.push({ role: m?.role === "assistant" ? "assistant" : "user", content: "" })
    }
  }
  return messages
}

function toolsToOpenAI(anthropicTools) {
  if (!Array.isArray(anthropicTools)) return undefined
  const tools = anthropicTools
    .filter((t) => t?.name)
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object" } },
    }))
  return tools.length ? tools : undefined
}

// --------------------------------------------------------------- response map

function stopReasonToAnthropic(openaiFinish, toolCalls) {
  if (toolCalls && toolCalls.length) return "tool_use"
  if (openaiFinish === "length") return "max_tokens"
  return "end_turn"
}

function openAIToAnthropic(body, requestedModel) {
  const choice = body?.choices?.[0] || {}
  const message = choice.message || {}
  const content = []
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content })
  }
  for (const call of message.tool_calls || []) {
    let input = {}
    try {
      input = JSON.parse(call.function?.arguments || "{}")
    } catch {}
    content.push({ type: "tool_use", id: call.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: call.function?.name, input })
  }
  const usage = body?.usage || {}
  return {
    id: `msg_${(body?.id || "chatcmpl").replace(/^chatcmpl-/, "")}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReasonToAnthropic(choice.finish_reason, message.tool_calls),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  }
}

// ------------------------------------------------------------------- surface

// The model id may be a pool, a provider/model escape hatch, or a native
// Anthropic name the client insists on (claude-*). Unknown names fall back to
// the first configured pool so the agent just works; the response echoes what
// the client asked for either way.
function resolvePool(modelId) {
  const cfg = config.load()
  const direct = modelId?.includes("/")
    ? null
    : cfg.pools.find((p) => p.id === modelId) || null
  if (direct) return { pool: direct }
  const explicit = (() => {
    const idx = (modelId || "").indexOf("/")
    if (idx === -1) return null
    const providerId = modelId.slice(0, idx)
    const provider = config.getProvider(providerId)
    return provider ? { id: modelId, name: modelId, keyStrategy: "round-robin", legs: [{ providerId, model: modelId.slice(idx + 1) }], _direct: true } : null
  })()
  if (explicit) return { pool: explicit }
  if (cfg.pools.length) return { pool: cfg.pools[0], fallback: true }
  return {}
}

// A throwaway response object that captures what the router would have written
// (same trick the old vision helper used) so /v1/messages can post-process it.
function captureRes() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    headers: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = { ...this.headers, ...headers }
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.writableEnded = true
    },
  }
}

async function messages(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (e) {
    return error(res, 400, `invalid request body: ${e.message}`)
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return error(res, 400, "messages: must be a non-empty array")
  }

  const { pool, fallback } = resolvePool(body.model)
  if (!pool) {
    return error(res, 404, "no pools configured — run: cupbearer setup")
  }

  const payload = {
    model: pool.id,
    messages: messagesToOpenAI(body.messages, body.system),
    max_tokens: body.max_tokens ?? 4096,
    stream: false,
  }
  const tools = toolsToOpenAI(body.tools)
  if (tools) payload.tools = tools
  if (body.temperature !== undefined) payload.temperature = body.temperature
  if (body.metadata?.user_id) payload.user = body.metadata.user_id

  const controller = new AbortController()
  req.on("close", () => {
    if (!res.writableEnded) controller.abort()
  })

  const captured = captureRes()
  let outcome
  try {
    outcome = await router.dispatch({ pool, payload, res: captured, signal: controller.signal })
  } catch (e) {
    return error(res, 500, `cupbearer router failure: ${e.message}`)
  }

  if (outcome.committed) {
    const openaiBody = JSON.parse(Buffer.concat(captured.chunks).toString("utf8") || "{}")
    const anthropicBody = openAIToAnthropic(openaiBody, body.model)

    if (body.stream) {
      // Replay the complete result as the Anthropic SSE event sequence.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-cupbearer-provider": captured.headers["x-cupbearer-provider"] || "",
        "x-cupbearer-model": captured.headers["x-cupbearer-model"] || "",
      })
      const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      event("message_start", { type: "message_start", message: { ...anthropicBody, content: [], usage: { ...anthropicBody.usage, output_tokens: 0 } } })
      anthropicBody.content.forEach((block, index) => {
        event("content_block_start", { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} } })
        if (block.type === "text") {
          // One delta with the whole text; simple and spec-conformant.
          event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
        } else {
          event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
        }
        event("content_block_stop", { type: "content_block_stop", index })
      })
      event("message_delta", { type: "message_delta", delta: { stop_reason: anthropicBody.stop_reason, stop_sequence: null }, usage: { output_tokens: anthropicBody.usage.output_tokens } })
      event("message_stop", { type: "message_stop" })
      return res.end()
    }

    if (fallback) {
      anthropicBody.cupbearer_note = `model "${body.model}" is not a configured pool — routed via "${pool.id}"`
    }
    return json(res, 200, anthropicBody)
  }

  if (outcome.requestError) {
    return error(res, outcome.status || 500, outcome.requestError.message, { reason: outcome.requestError.reason })
  }
  const detail = (outcome.attempts || [])
    .map((a) => (a.skipped ? `${a.provider}/${a.model}: skipped (${a.skipped})` : `${a.provider}/${a.model}: ${a.reason || "failed"}`))
    .join("; ")
  return error(res, 502, `pool "${pool.id}" has no working provider. ${detail || "no legs configured"}`)
}

module.exports = { messages, _internals: { messagesToOpenAI, toolsToOpenAI, openAIToAnthropic, resolvePool, contentBlocksToOpenAI } }
