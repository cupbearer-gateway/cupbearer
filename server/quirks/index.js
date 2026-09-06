"use strict"
// DOC: ../../docs/quirks.md → § The quirk interface · § Gotchas

// Quirk registry + composition.
//
// A quirk is a narrowly-scoped per-provider adaptation. Each may implement any
// subset of these hooks; the router applies whatever is present, in the order
// the provider lists them.
//
//   transformRequest(body, ctx)      -> body       mutate the outbound JSON
//   transformHeaders(headers, ctx)   -> headers    mutate outbound headers
//   transformResponse(payload, ctx)  -> payload    rewrite a non-streaming body
//   filterStreamLine(line, ctx)      -> boolean    false drops the SSE line
//   createStreamTranslator(ctx)      -> translator rewrite streaming deltas
//
// Only one quirk may supply a stream translator, since translation is stateful
// and ordering two of them is ambiguous. Registering two is a config error we
// surface loudly rather than silently picking one.

const REGISTRY = new Map()

for (const mod of [
  require("./qwen-xml"),
  require("./think-tags"),
  require("./deepseek-tools"),
  require("./waf-headers"),
  require("./sse-null"),
  require("./nvidia-nim"),
  require("./openrouter"),
  require("./aistudio-schema"),
  require("./aistudio-think-sig"),
  require("./aistudio-multipart"),
]) {
  REGISTRY.set(mod.id, mod)
}

function get(id) {
  return REGISTRY.get(id) || null
}

function list() {
  return [...REGISTRY.values()].map((q) => ({ id: q.id, description: q.description }))
}

function unknown(ids = []) {
  return ids.filter((id) => !REGISTRY.has(id))
}

/**
 * Compose a provider's quirk list into a single applicator.
 * @param {string[]} ids
 */
function compose(ids = []) {
  const quirks = ids.map((id) => {
    const q = REGISTRY.get(id)
    if (!q) throw new Error(`cupbearer: unknown quirk "${id}"`)
    return q
  })

  const translators = quirks.filter((q) => typeof q.createStreamTranslator === "function")
  if (translators.length > 1) {
    throw new Error(
      `cupbearer: quirks [${translators.map((q) => q.id).join(", ")}] each provide a stream translator; at most one is allowed`,
    )
  }

  return {
    ids,

    request(body, ctx) {
      let out = body
      for (const q of quirks) if (q.transformRequest) out = q.transformRequest(out, ctx)
      return out
    },

    headers(headers, ctx) {
      let out = headers
      for (const q of quirks) if (q.transformHeaders) out = q.transformHeaders(out, ctx)
      return out
    },

    response(payload, ctx) {
      let out = payload
      for (const q of quirks) if (q.transformResponse) out = q.transformResponse(out, ctx)
      return out
    },

    // A line survives only if every filter accepts it.
    keepStreamLine(line, ctx) {
      for (const q of quirks) {
        if (q.filterStreamLine && q.filterStreamLine(line, ctx) === false) return false
      }
      return true
    },

    // null when no quirk rewrites the stream — the fast passthrough path.
    streamTranslator(ctx) {
      return translators.length ? translators[0].createStreamTranslator(ctx) : null
    },

    get hasStreamTranslator() {
      return translators.length > 0
    },
  }
}

module.exports = { get, list, compose, unknown, REGISTRY }
