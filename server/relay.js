"use strict"
// DOC: ../docs/architecture.md → § Module map → server/relay.js · § Deferred commit · ../docs/quirks.md → § The stream translator contract

// SSE relay: upstream stream -> client, with optional per-line filtering and
// optional delta translation.
//
// Called after the router has opened a stream, but NOT necessarily after it has
// committed: `onFirstByte` is invoked immediately before the first byte is
// flushed, and the router uses it to write response headers at the last possible
// moment. Everything before that point is still recoverable, which matters
// because a translator that buffers tool calls (see `pushToolCalls`) may only
// discover the response is unusable at end of stream. In that case nothing has
// been written, `committed` comes back false, and the router can fail over to
// another provider.
//
// Once a byte IS flushed, a mid-stream failure is surfaced as an SSE error event
// rather than retried, because the client already holds partial output and a
// silent provider switch would splice two responses together.

function sseEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/**
 * @param {object} opts
 * @param {Response} opts.upstream        fetch Response with unread SSE body
 * @param {import("http").ServerResponse} opts.res
 * @param {object} opts.applied           composed quirks
 * @param {object} opts.ctx               { provider, model, tools, stream }
 * @param {number} opts.chunkTimeoutMs    abort if no bytes arrive for this long
 *                                        once the stream is already flowing
 * @param {number} [opts.firstChunkTimeoutMs] abort if the FIRST byte takes this
 *                                        long. Separate because nothing is
 *                                        committed yet, so the router can still
 *                                        fail over; defaults to chunkTimeoutMs.
 * @param {Function} [opts.onFirstByte]   called immediately before the first byte
 *                                        is flushed; the router writes headers here
 * @param {boolean} [opts.buffer]         collect every frame and return them
 *                                        instead of writing; used by the router
 *                                        to quality-gate a downgrade pre-commit
 * @returns {Promise<{tokensIn:number,tokensOut:number,finishReason:string|null,errored:boolean,verdict:object|null,errorMessage:string|null,errorBody:object|null,wrote:boolean,text:string,reasoning:string,toolCalls:object[]|null,sawToolCalls:boolean,frames?:string}>}
 */
async function relay({ upstream, res, applied, ctx, chunkTimeoutMs = 60000, firstChunkTimeoutMs, onFirstByte, buffer: buffered = false }) {
  const translator = applied.streamTranslator(ctx)

  let tokensIn = 0
  let tokensOut = 0
  let finishReason = null
  let errored = false
  let announcedFirstByte = false
  let sawNativeToolCalls = false
  let forwardedFinish = false
  // Accumulated plain text (and reasoning) across the whole stream. The quality
  // gate's evaluators read these; the passthrough path needs them because
  // forwarded-verbatim chunks are otherwise opaque.
  let textAccum = ""
  let reasoningAccum = ""
  let synthToolCalls = null
  // Buffered mode: frames are collected and returned instead of written, so the
  // router can quality-gate a downgrade before anything reaches the client.
  const frames = []
  // Set when the failure is specific enough to classify (see the translator's
  // finish() error contract); the router prefers it over a generic stream_failed.
  let verdict = null
  let errorMessage = null
  // Body of an in-stream error object, so the router can classify it the same
  // way it classifies a non-2xx response body.
  let errorBody = null

  // Reused envelope for chunks we synthesise during translation.
  let template = null
  const base = (extra) => {
    const t = template ?? {}
    return {
      id: t.id ?? "chatcmpl-cupbearer",
      object: "chat.completion.chunk",
      created: t.created ?? Math.floor(Date.now() / 1000),
      model: t.model ?? ctx?.model ?? "unknown",
      ...extra,
    }
  }

  const write = (s) => {
    if (buffered) {
      frames.push(s)
      return
    }
    if (!announcedFirstByte) {
      announcedFirstByte = true
      onFirstByte?.()
    }
    res.write(s)
  }

  const emitFragments = (fragments) => {
    for (const f of fragments) {
      const delta = f.reasoning !== undefined ? { reasoning_content: f.reasoning } : { content: f.text }
      if (f.reasoning !== undefined) reasoningAccum += f.reasoning
      else textAccum += f.text
      write(sseEvent(base({ choices: [{ index: 0, delta, logprobs: null, finish_reason: null }] })))
    }
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let finished = false
  let trailingUsage = null
  // Did the upstream send us anything at all? Distinguishes "accepted the request
  // then went silent" (the provider is dead; nothing committed, so fail over)
  // from "dropped mid-response" (the client may already hold output).
  let sawAnyChunk = false

  const finalizeTranslated = () => {
    if (finished) return
    finished = true
    const { fragments, toolCalls: synthesised, error: translatorError } = translator.finish()
    emitFragments(fragments)

    // The translator rejected what the upstream produced (e.g. tool arguments
    // truncated mid-JSON). If nothing has been flushed yet the router can still
    // fail over, so stay silent and let it decide; otherwise report it inline.
    if (translatorError) {
      errored = true
      verdict = translatorError.cupbearerVerdict ?? null
      errorMessage = translatorError.message
      if (announcedFirstByte) {
        write(
          sseEvent({
            error: { message: `cupbearer: ${translatorError.message}`, type: verdict?.reason || "upstream_error" },
          }),
        )
        write("data: [DONE]\n\n")
      }
      return
    }

    // When the upstream already streamed real tool_calls we forwarded them
    // verbatim; a translator must not also synthesise a second set.
    const toolCalls = sawNativeToolCalls ? null : synthesised
    if (toolCalls) synthToolCalls = toolCalls
    if (toolCalls) {
      write(
        sseEvent(
          base({
            choices: [
              { index: 0, delta: { role: "assistant", tool_calls: toolCalls }, logprobs: null, finish_reason: null },
            ],
          }),
        ),
      )
    }
    finishReason = toolCalls || sawNativeToolCalls ? "tool_calls" : finishReason || "stop"
    // Some upstreams (minimax) carry finish_reason on the tool_calls chunk we
    // already forwarded verbatim; a second finish chunk would be a duplicate.
    if (!forwardedFinish) {
      write(sseEvent(base({ choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }] })))
    }
    if (trailingUsage) write(sseEvent(base({ choices: [], usage: trailingUsage })))
    write("data: [DONE]\n\n")
  }

  // Observe usage/finish on the passthrough path without rewriting anything.
  const observe = (payload) => {
    if (payload?.usage) {
      tokensIn = payload.usage.prompt_tokens ?? tokensIn
      tokensOut = payload.usage.completion_tokens ?? tokensOut
    }
    const fr = payload?.choices?.[0]?.finish_reason
    if (fr) finishReason = fr
    // Text accumulation for the quality gate — passthrough only. The translated
    // path accumulates in emitFragments; observing there would double-count.
    if (!translator) {
      const d = payload?.choices?.[0]?.delta
      if (typeof d?.content === "string") textAccum += d.content
      if (typeof d?.reasoning_content === "string") reasoningAccum += d.reasoning_content
    }
  }

  const handleLine = (line) => {
    if (!applied.keepStreamLine(line, ctx)) return

    const trimmed = line.trim()

    if (!translator) {
      // Passthrough: forward verbatim, only peeking for metrics.
      if (trimmed.startsWith("data:")) {
        const d = trimmed.slice(5).trim()
        if (d !== "[DONE]" && d !== "null") {
          try {
            observe(JSON.parse(d))
          } catch {}
        }
      }
      write(line.endsWith("\n") ? line : line + "\n")
      return
    }

    // Translated path.
    if (!trimmed) return
    if (!trimmed.startsWith("data:")) return // comments and keepalives
    const data = trimmed.slice(5).trim()
    if (data === "[DONE]") {
      finalizeTranslated()
      return
    }
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    // An error object inside the stream. Upstreams do this instead of a non-2xx
    // when they fail after the headers are already out (vyce returns
    // "An internal error occurred" this way). If nothing has been flushed the
    // router can still fail over, so withhold it and hand the body back.
    if (chunk.error) {
      errored = true
      errorBody = chunk
      errorMessage = chunk.error?.message || "upstream reported an error mid-stream"
      if (announcedFirstByte) write(sseEvent(chunk))
      finished = true
      return
    }
    template = chunk
    observe(chunk)

    const choice = chunk.choices?.[0]
    if (!choice) {
      // Usage-only trailer: hold until after our synthesised finish chunk.
      if (chunk.usage) trailingUsage = chunk.usage
      return
    }
    const delta = choice.delta ?? {}

    // Native tool_calls.
    //
    // A translator that implements pushToolCalls takes ownership of them: it
    // accumulates every argument fragment and emits the finished set from
    // finish(). That is required for upstreams which duplicate calls or stream
    // arguments interleaved with prose, since neither can be judged until the
    // stream ends.
    //
    // Otherwise forward verbatim — but do NOT end the stream here. Arguments
    // arrive across many chunks, and some upstreams emit trailing content after
    // the last fragment; stopping at the first chunk truncated the arguments so
    // the client saw a call with no parameters.
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      if (typeof translator.pushToolCalls === "function") {
        emitFragments(translator.pushToolCalls(delta.tool_calls) || [])
      } else {
        sawNativeToolCalls = true
        write(sseEvent(chunk))
        if (choice.finish_reason) forwardedFinish = true
      }
      if (choice.finish_reason) finalizeTranslated()
      return
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      write(
        sseEvent(
          base({
            choices: [
              {
                index: 0,
                delta: { reasoning_content: delta.reasoning_content },
                logprobs: null,
                finish_reason: null,
              },
            ],
          }),
        ),
      )
    }
    if (typeof delta.content === "string" && delta.content) emitFragments(translator.push(delta.content))
    if (choice.finish_reason) finalizeTranslated()
  }

  try {
    for (;;) {
      // Before the first chunk the attempt is still abandonable, so that wait
      // gets its own (tighter) budget; afterwards a gap may just be the model
      // pausing between tool calls, and we are committed either way.
      const waitMs = sawAnyChunk ? chunkTimeoutMs : (firstChunkTimeoutMs ?? chunkTimeoutMs)
      const step = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  sawAnyChunk
                    ? `no data from upstream for ${waitMs}ms`
                    : `no first byte from upstream for ${waitMs}ms`,
                ),
              ),
            waitMs,
          ).unref?.(),
        ),
      ])
      if (step.done) break
      sawAnyChunk = true
      buf += decoder.decode(step.value, { stream: true })

      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx + 1)
        buf = buf.slice(idx + 1)
        handleLine(line)
      }
      if (finished) break
    }
    if (buf) handleLine(buf)
    if (translator) finalizeTranslated()
  } catch (e) {
    errored = true
    errorMessage = `upstream stream failed: ${e.message}`
    // Only reportable inline if the client is already receiving this response;
    // otherwise the router still owns the decision and can fail over.
    if (announcedFirstByte) {
      try {
        write(
          sseEvent({
            error: { message: `cupbearer: upstream stream failed: ${e.message}`, type: "upstream_stream_error" },
          }),
        )
        write("data: [DONE]\n\n")
      } catch {}
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
  }

  return {
    tokensIn,
    tokensOut,
    finishReason,
    errored,
    verdict,
    errorMessage,
    errorBody,
    wrote: announcedFirstByte,
    sawUpstreamBytes: sawAnyChunk,
    // Quality-gate inputs and buffered output (buffer mode only).
    text: textAccum,
    reasoning: reasoningAccum,
    toolCalls: synthToolCalls,
    sawToolCalls: sawNativeToolCalls,
    frames: buffered ? frames.join("") : undefined,
  }
}

module.exports = { relay, sseEvent }
