"use strict"

const { test } = require("node:test")
const assert = require("node:assert")
const { classify, cleanMessage } = require("./classify")

// Every fixture below is a verbatim response body captured during Phase 0
// probing of the real gateways. If a gateway changes its wording, these tests
// are where it surfaces.

test("agentrouter budget pool exhausted -> exhausted, key-scoped", () => {
  const r = classify({
    status: 402,
    body: {
      error: {
        message:
          "Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool. (request id: 20260901060903817155239b97n6Z7hPFGqQ)",
        type: "bad_response_status_code",
      },
      type: "error",
    },
  })
  assert.equal(r.reason, "budget_exhausted")
  assert.equal(r.keyState, "exhausted")
  assert.equal(r.scope, "key")
  assert.equal(r.retry, true)
  assert.ok(!r.message.includes("request id"), "request id should be stripped")
})

test("kktoken/gorouter invalid token -> auth_failed", () => {
  const r = classify({
    status: 401,
    body: {
      error: {
        code: "",
        message: "Invalid token (request id: 202608312149176519222738268d9d6D79XuWht)",
        type: "new_api_error",
      },
    },
  })
  assert.equal(r.reason, "invalid_key")
  assert.equal(r.keyState, "auth_failed")
  assert.equal(r.message, "Invalid token")
})

test("true-sota group disabled -> auth_failed", () => {
  const r = classify({
    status: 403,
    body: { code: "GROUP_DISABLED", message: "API Key 所属分组已停用" },
  })
  assert.equal(r.reason, "group_disabled")
  assert.equal(r.keyState, "auth_failed")
})

test("agentrouter WAF rejection blames the leg, not the key", () => {
  // Our own missing headers caused this. Marking the key auth_failed would
  // wrongly retire a perfectly good key.
  const r = classify({
    status: 401,
    body: {
      error: { message: "unauthorized client detected, contact support for assistance at https://discord.gg/x" },
      message: "UNAUTHENTICATED",
      success: false,
      type: "unauthorized_client_error",
    },
  })
  assert.equal(r.reason, "client_rejected")
  assert.equal(r.scope, "leg")
  assert.notEqual(r.keyState, "auth_failed")
})

test("seekai concurrency limit -> cooling", () => {
  const r = classify({
    status: 429,
    body: { error: { message: "Concurrency limit exceeded for user, please retry later", type: "rate_limit_error" } },
  })
  assert.equal(r.reason, "concurrency_limit")
  assert.equal(r.keyState, "cooling")
  assert.equal(r.scope, "key")
})

test("no available channel is leg-scoped and does not blame the key", () => {
  const english = classify({
    status: 503,
    body: {
      error: {
        message:
          "No available channel for model claude-opus-5 under group default (distributor) (request id: 202608312149304914663218268d9d6AWl8s6Zz)",
        type: "new_api_error",
      },
    },
  })
  assert.equal(english.reason, "no_channel")
  assert.equal(english.scope, "leg")
  assert.equal(english.keyState, "healthy")

  const chinese = classify({
    status: 503,
    body: {
      error: {
        message: "当前分组 default 下对于模型 claude-opus-4-6 无可用渠道 (request id: 2026090106090339789706)",
        type: "new_api_error",
      },
    },
  })
  assert.equal(chinese.reason, "no_channel")
  assert.equal(chinese.scope, "leg")
})

test("transport failure is degraded and retryable, key not blamed", () => {
  const r = classify({ error: Object.assign(new Error("fetch failed"), { name: "TypeError" }) })
  assert.equal(r.reason, "connection_failed")
  assert.equal(r.keyState, "degraded")
  assert.equal(r.retry, true)
})

test("abort is reported as a timeout", () => {
  const r = classify({ error: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) })
  assert.equal(r.reason, "timeout")
})

test("request-scoped errors do not retry the same key", () => {
  const ctx = classify({
    status: 400,
    body: { error: { message: "This model's maximum context length is 200000 tokens" } },
  })
  assert.equal(ctx.reason, "context_too_long")
  assert.equal(ctx.scope, "request")
  assert.equal(ctx.retry, false, "the same key with the same payload fails identically")
  // Whether another PROVIDER is worth trying is the router's call: context windows
  // are per-deployment (vyce caps deepseek-v4-flash at 128k, gonkarouter does not),
  // so this reason is in router.RETRY_ON_ANOTHER_LEG. Pinned in
  // router.request-failover.test.js.
})

test("status-only fallbacks still classify", () => {
  assert.equal(classify({ status: 402, body: {} }).keyState, "exhausted")
  assert.equal(classify({ status: 429, body: {} }).keyState, "cooling")
  assert.equal(classify({ status: 500, body: {} }).keyState, "degraded")
  assert.equal(classify({ status: 404, body: {} }).scope, "leg")
})

test("an odd 4xx blames the leg, not the key", () => {
  // Observed: agentrouter answering 405 to a normal chat-completions POST. A
  // protocol/routing mismatch says nothing about the credential, so it must not
  // be `degraded` — that counts toward errorPullAfterFailures and would kill a
  // working key after three of them. Leg-scoped: every key here hits it.
  const r = classify({ status: 405, body: "Method Not Allowed" })
  assert.equal(r.reason, "http_405")
  assert.equal(r.keyState, "healthy")
  assert.equal(r.scope, "leg")
  assert.equal(r.retry, true)
})

test("message rules outrank ambiguous 400s", () => {
  // Some gateways report billing problems with a 400.
  const r = classify({ status: 400, body: { error: { message: "insufficient balance" } } })
  assert.equal(r.keyState, "exhausted")
})

test("cleanMessage strips only the request id suffix", () => {
  assert.equal(cleanMessage("Invalid token (request id: abc123)"), "Invalid token")
  assert.equal(cleanMessage("plain message"), "plain message")
})

// --- NVIDIA NIM + OpenRouter (the vision pool's upstreams) -------------------

test("NVIDIA worker cap is cooling, whichever way it arrives", () => {
  // Same cause, three observed shapes: an error object inside a 200 SSE stream
  // (so status 0 by the time the relay hands it over), a plain 503, and
  // OpenRouter relaying it with a prefix.
  const inStream = classify({
    status: 0,
    body: {
      error: {
        message: "ResourceExhausted: Worker local total request limit reached (16/16)",
        type: "internal_server_error",
        code: 500,
      },
    },
  })
  assert.equal(inStream.reason, "concurrency_limit")
  assert.equal(inStream.keyState, "cooling")
  assert.equal(inStream.scope, "key")

  const http503 = classify({
    status: 503,
    body: { error: { message: "ResourceExhausted: Worker local total request limit reached (16/16)", code: 500 } },
  })
  assert.equal(http503.reason, "concurrency_limit")
  assert.equal(http503.keyState, "cooling")

  const relayed = classify({
    status: 0,
    body: { error: { message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)" } },
  })
  assert.equal(relayed.reason, "concurrency_limit")
})

test("NVIDIA worker cap must not be degraded — that would kill a good key", () => {
  // degraded counts toward settings.errorPullAfterFailures (3), so three
  // concurrency bursts in a row would mark a working key dead. cooling backs
  // off and returns it automatically.
  const r = classify({
    status: 503,
    body: { error: { message: "ResourceExhausted: Worker local total request limit reached (16/16)" } },
  })
  assert.notEqual(r.keyState, "degraded")
  assert.notEqual(r.keyState, "dead")
})

test("a retired model retires the leg, not the key", () => {
  // Live: nvidia/llama-3.1-nemotron-nano-vl-8b-v1 returned 410 after its EOL date.
  const r = classify({
    status: 410,
    body: {
      type: "about:blank",
      title: "Gone",
      status: 410,
      detail:
        "The model 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available.",
    },
  })
  assert.equal(r.reason, "model_retired")
  assert.equal(r.scope, "leg")
  assert.equal(r.keyState, "healthy")
})

test("a harness-gated model is leg-scoped, not a rejected key", () => {
  // Live: OpenRouter 403 on thinkingmachines/inkling:free. The bare 403 fallback
  // is auth_failed + sticky, which would pull a working key from every pool.
  const r = classify({
    status: 403,
    body: {
      error: {
        message:
          "thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps",
        code: 403,
      },
    },
  })
  assert.equal(r.reason, "model_gated")
  assert.equal(r.scope, "leg")
  assert.equal(r.keyState, "healthy")
})

test("OpenRouter free-tier rate limit cools the key", () => {
  const r = classify({
    status: 429,
    body: {
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: {
          raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits",
          provider_name: "Google AI Studio",
        },
      },
    },
  })
  assert.equal(r.reason, "rate_limited")
  assert.equal(r.keyState, "cooling")
})

test("NVIDIA image-tokens 400 is request-scoped, so the same key is not retried", () => {
  // Symptom of a missing nvidia-nim quirk (tools sent with an image). No message
  // rule matches, so this lands on the bare-400 fallback: request-scoped, meaning
  // no other KEY on this provider gets the same payload.
  //
  // It does not mean no other PROVIDER should be tried. Quirks are per-provider
  // and `applied.request()` runs per attempt, so the payload is literally not the
  // same on the next leg — the vision pool spans nvidia and openrouter with
  // different image handling each. The router therefore allows `bad_request` one
  // more leg (router.RETRY_ON_ANOTHER_LEG); that decision lives there, not here.
  const r = classify({
    status: 400,
    body: {
      error: {
        message: "The number of image tokens (0) must be the same as the number of images (1)",
        type: "BadRequestError",
        code: 400,
      },
    },
  })
  assert.equal(r.scope, "request")
  assert.equal(r.retry, false)
  assert.equal(r.keyState, "healthy")
  assert.equal(r.reason, "bad_request")
})

// --- observed live on 2026-09-04, after the move -----------------------------

test("tabitoken's pre-charge hold failure is out of quota, not a rejected key", () => {
  // Real 403 body. The bare-403 fallback called this auth_failed, which parks the
  // key as if the credential were revoked; it is simply out of money.
  const v = classify({
    status: 403,
    body: {
      error: {
        message: "预扣费额度失败, 用户剩余额度: ＄0.401526, 需要预扣费额度: ＄0.800000",
      },
    },
  })
  assert.equal(v.keyState, "exhausted")
  assert.equal(v.reason, "credit_exhausted")
  assert.equal(v.scope, "key")
})

test("a full request queue cools the key instead of killing it", () => {
  // hcnapi, observed: three of these in a row promoted the key to `dead`, so a
  // merely busy provider looked permanently broken.
  const v = classify({ status: 500, body: { error: { message: "The request queue is full." } } })
  assert.equal(v.keyState, "cooling")
  assert.equal(v.reason, "provider_busy")
  assert.equal(v.retry, true)
})

test("an overloaded upstream is also cooling, not degraded", () => {
  const v = classify({ status: 503, body: { error: { message: "Server is busy, please retry" } } })
  assert.equal(v.keyState, "cooling")
  assert.equal(v.reason, "provider_busy")
})
