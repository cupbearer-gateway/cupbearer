"use strict"
// DOC: ../../docs/quirks.md → § nvidia-nim

// Quirk: nvidia-nim
//
// For the `nvidia` provider (integrate.api.nvidia.com). Its OpenAI surface is
// clean for text — no <think> leakage, native reasoning_content, native
// tool_calls — but two things break specifically on image requests. Both were
// captured on the wire against the live endpoint.
//
// 1. `tools` + an image is a hard 400 on the Llama vision models. Verbatim,
//    from meta/llama-3.2-11b-vision-instruct with one image_url part and a
//    single-tool array:
//
//      {"message":"The number of image tokens (0) must be the same as the
//       number of images (1)","type":"BadRequestError","param":null,"code":400}
//
//    Reproduced 3/3 times. It is the *presence* of the key that breaks it, not
//    its contents: `tools: []` and `tool_choice: "none"` fail identically, so
//    the model never sees the image at all. Without `tools` the same request
//    answers correctly in ~3s. opencode always sends its tool array, so a
//    vision pool leg is unusable unless the key is removed. Scoped to the Llama
//    vision family — nemotron-3-nano-omni handles tools and an image together
//    fine, and stripping tools from a model that can use them would be wrong.
//
// 2. The omni reasoning model spends its budget thinking about the picture.
//    Baseline on a 1920x1080 screenshot: 2220 chars of reasoning_content and
//    27s for 1673 chars of answer. With `chat_template_kwargs.thinking: false`:
//    no reasoning, 18s, and 3405 chars of *more detailed* answer. Reasoning
//    also competes with the answer for max_tokens — at a small budget the
//    monologue consumes all of it and content comes back empty with
//    finish_reason "length". Disabled for image requests only.
//
// Not handled here, deliberately: NVIDIA reports its per-account concurrency
// cap as an error object inside an otherwise-200 SSE stream —
//
//   {"message":"ResourceExhausted: Worker local total request limit reached
//    (16/16)","type":"internal_server_error","code":500}
//
// It arrives on the second line with no content before it, so the relay has
// flushed nothing and the router can still fail over. classify.js turns it into
// a cooling key (§ concurrency_limit), which is the correct handling — a quirk
// would only get in the way.

const TOOLS_BREAK_VISION = /llama-3\.2-\d+b-vision/i
const THINKS_ABOUT_IMAGES = /nemotron-3-nano-omni/i

// True when any message carries an image part, i.e. this is a vision request.
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
  id: "nvidia-nim",
  description:
    "For NVIDIA NIM: drops the tools array on image requests to the Llama vision models (their presence makes the model miss the image entirely) and disables the omni model's thinking so reasoning does not eat the answer's token budget.",

  transformRequest(body, ctx) {
    if (!hasImage(body)) return body
    const model = ctx?.model || body?.model || ""
    let out = body

    if (TOOLS_BREAK_VISION.test(model) && (out.tools !== undefined || out.tool_choice !== undefined)) {
      out = { ...out }
      delete out.tools
      delete out.tool_choice
    }

    // Never override an explicit choice by the caller.
    if (THINKS_ABOUT_IMAGES.test(model) && out.chat_template_kwargs === undefined) {
      out = { ...out, chat_template_kwargs: { thinking: false } }
    }

    return out
  },

  _internals: { hasImage },
}
