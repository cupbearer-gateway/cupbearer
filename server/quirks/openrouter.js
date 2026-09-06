"use strict"
// DOC: ../../docs/quirks.md → § openrouter

// Quirk: openrouter
//
// For the `openrouter` provider (openrouter.ai/api/v1). Three things, all
// captured on the wire.
//
// 1. Reasoning is billed against max_tokens and can consume all of it. On
//    dots-studio/dots-3-note-preview:free with max_tokens 120 the whole budget
//    went to reasoning: 454 chars of it, `content` empty, finish_reason
//    "length" — a silent empty answer. `reasoning: { enabled: false }` removes
//    it: same request answered in 1.3s using 17 completion tokens instead of
//    387, with identical text. On a hard 1920x1080 screenshot the answer with
//    reasoning off was no worse.
//
//    Only applied to image requests, and only when the caller has not asked for
//    reasoning itself. A vision call wants the description, not the monologue;
//    a text call on a reasoning model may genuinely want it.
//
// 2. OpenRouter streams `: OPENROUTER PROCESSING` comment lines as keepalives
//    while a free model is queued — observed 1 to 6 of them before the first
//    real delta. SSE comments are legal and `relay.js` already ignores them on
//    the translated path, but on the *passthrough* path they are forwarded
//    verbatim, and a forwarded byte commits the attempt (§ Deferred commit).
//    That matters because the queue wait is exactly when a free model is most
//    likely to fail. Dropping them keeps failover available until real content
//    arrives, and costs opencode nothing — it never needed them.
//
// 3. Attribution headers. OpenRouter ranks and displays traffic by `HTTP-Referer`
//    and `X-Title`. Requests work without them (verified: 200 with no referer),
//    so this is not a WAF workaround like `waf-headers` — it just stops the
//    traffic showing up as anonymous.
//
// Not handled here: the 403 on `thinkingmachines/inkling:free`
// ("only available on agentic harnesses") and the 429 on the Gemma free models
// both arrive as a proper HTTP status *before* any bytes, so classify.js already
// handles them — forbidden pulls the leg, rate_limited cools the key.

const REASONING_MODELS = /reasoning|dots-3|:thinking/i

function hasImage(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    for (const part of m.content) {
      if (part?.type === "image_url" && part?.image_url?.url) return true
    }
  }
  return false
}

module.exports = {
  id: "openrouter",
  description:
    "For OpenRouter: disables reasoning on image requests (it is billed against max_tokens and can consume the whole budget, leaving content empty), drops the ': OPENROUTER PROCESSING' keepalive comments so a queued free model does not commit the attempt before real content arrives, and adds the attribution headers.",

  transformRequest(body, ctx) {
    const model = ctx?.model || body?.model || ""
    if (!hasImage(body)) return body
    if (body?.reasoning !== undefined) return body // caller decided
    if (!REASONING_MODELS.test(model)) return body
    return { ...body, reasoning: { enabled: false } }
  },

  transformHeaders(headers) {
    return { ...headers, "http-referer": "https://opencode.ai", "x-title": "opencode (cupbearer)" }
  },

  // ": OPENROUTER PROCESSING" and any other SSE comment. Dropping a comment can
  // never lose data: by definition it carries none.
  filterStreamLine(line) {
    return !line.trimStart().startsWith(":")
  },

  _internals: { hasImage },
}
