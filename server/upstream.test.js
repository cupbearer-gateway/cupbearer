"use strict"

// Isolation: never touch the live gateway's real config dir.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

// Regression tests for upstream.js' outbound-call edges:
//  - the header timer must stay armed while an error/JSON body is read (a
//    trickling 500 body used to wedge the attempt forever),
//  - a user-authored quirk throwing while shaping the call comes back as a
//    classified bad_quirks failure the router can fail over on, not a bare 500,
//  - the upstream error-body read is capped before it reaches the classifier.

const test = require("node:test")
const assert = require("node:assert")
const secrets = require("./secrets")
const upstream = require("./upstream")

const PROVIDER = { id: "p", label: "P", enabled: true, baseURL: "https://p.test/v1", quirks: [], keys: [{ id: "p:key-1" }] }
const PAYLOAD = { model: "m", messages: [{ role: "user", content: "hi" }] }

// A compliant `applied` stand-in; individual tests override the hook under test.
const IDENT = {
  request: (b) => b,
  headers: (h) => h,
  response: (p) => p,
  keepStreamLine: () => true,
  streamTranslator: () => null,
}

function abortError() {
  const e = new Error("This operation was aborted")
  e.name = "AbortError"
  return e
}

// A body that trickles a small chunk forever. Like the real undici body it
// rejects once the fetch signal aborts; `stop` is the test's kill switch.
// Timers are unref'd so a wedged attempt cannot hang the runner.
function trickleBody(signal, stop) {
  const encoder = new TextEncoder()
  return {
    getReader() {
      return {
        read: () =>
          new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError())
            if (stop.aborted) return resolve({ done: true })
            const t = setTimeout(() => resolve({ done: false, value: encoder.encode("x".repeat(1024)) }), 20)
            t.unref?.()
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t)
                reject(abortError())
              },
              { once: true },
            )
          }),
        cancel: async () => {
          stop.aborted = true
        },
      }
    },
  }
}

// A res.text() that trickles the same way, for the paths that read via text().
function tricklingText(signal, stop) {
  return () =>
    new Promise((resolve, reject) => {
      let out = ""
      const pump = () => {
        if (signal?.aborted) return reject(abortError())
        if (stop.aborted) return resolve(out)
        out += "x".repeat(1024)
        const t = setTimeout(pump, 20)
        t.unref?.()
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            reject(abortError())
          },
          { once: true },
        )
      }
      pump()
    })
}

const RACE_GUARD_MS = 2000

// Runs `fn` with global.fetch replaced. Fail the test (rather than hang it) if
// openStream never settles — the pre-fix behavior for a trickling body.
async function withFetch(fake, fn) {
  const realFetch = global.fetch
  const realGet = secrets.get
  secrets.get = () => "sk-test"
  global.fetch = fake
  try {
    return await fn()
  } finally {
    global.fetch = realFetch
    secrets.get = realGet
  }
}

function openStreamWatches(signalRef, { ok, status, contentType, delayMs = 0 } = {}) {
  return async (url, opts = {}) => {
    signalRef.signal = opts.signal
    const encoder = new TextEncoder()
    const sse =
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, logprobs: null, finish_reason: null }] })}\n\n` +
      "data: [DONE]\n\n"
    const stop = { aborted: false }
    const body =
      contentType === "text/event-stream"
        ? {
            getReader() {
              let sent = false
              return {
                read: () =>
                  new Promise((resolve, reject) => {
                    if (signalRef.signal?.aborted) return reject(abortError())
                    const t = setTimeout(() => {
                      sent = true
                      resolve({ done: false, value: encoder.encode(sse) })
                    }, delayMs)
                    t.unref?.()
                    signalRef.signal?.addEventListener(
                      "abort",
                      () => {
                        clearTimeout(t)
                        reject(abortError())
                      },
                      { once: true },
                    )
                  }),
                cancel: async () => {
                  stop.aborted = true
                },
              }
            },
          }
        : trickleBody(signalRef.signal, stop)
    return {
      ok,
      status,
      headers: { get: (h) => (/content-type/i.test(h) ? contentType : null) },
      body,
      text: tricklingText(signalRef.signal, stop),
    }
  }
}

test("openStream keeps the header timer armed while a 500 body trickles in", async () => {
  const signalRef = {}
  await withFetch(openStreamWatches(signalRef, { ok: false, status: 500, contentType: "text/html" }), async () => {
    const t0 = Date.now()
    const outcome = await Promise.race([
      upstream.openStream({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied: IDENT, timeoutMs: 250 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("openStream wedged on the trickling error body")), RACE_GUARD_MS)),
    ])
    assert.ok(Date.now() - t0 < RACE_GUARD_MS - 200, "the attempt must end when the header timer fires")
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.name, "AbortError", "cut by the still-armed header timer, not left to trickle")
  })
})

test("openStream keeps the header timer armed while a surprise JSON body trickles in", async () => {
  const signalRef = {}
  await withFetch(openStreamWatches(signalRef, { ok: true, status: 200, contentType: "application/json" }), async () => {
    const outcome = await Promise.race([
      upstream.openStream({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied: IDENT, timeoutMs: 250 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("openStream wedged on the trickling JSON body")), RACE_GUARD_MS)),
    ])
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.name, "AbortError")
  })
})

test("a healthy SSE stream is not killed by the header timer after handback", async () => {
  const signalRef = {}
  await withFetch(openStreamWatches(signalRef, { ok: true, status: 200, contentType: "text/event-stream", delayMs: 150 }), async () => {
    const out = await upstream.openStream({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied: IDENT, timeoutMs: 100 })
    assert.equal(out.ok, true)
    // Outlive the (disarmed) header window before touching the body.
    await new Promise((r) => setTimeout(r, 300))
    const first = await out.res.body.getReader().read()
    assert.equal(first.done, false, "the handed-back stream still delivers")
  })
})

test("a quirk throwing while shaping the request is a classified bad_quirks failure", async () => {
  let fetched = 0
  await withFetch(
    async () => {
      fetched++
      throw new Error("must not be reached")
    },
    async () => {
      const applied = { ...IDENT, request: () => { throw new Error("exploding transformRequest") } }
      const out = await upstream.callJson({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied, timeoutMs: 500 })
      assert.equal(out.ok, false)
      assert.equal(out.status, 0)
      assert.equal(out.error.cupbearerVerdict.reason, "bad_quirks")
      assert.equal(out.error.cupbearerVerdict.scope, "leg")
      assert.equal(out.error.cupbearerVerdict.keyState, "healthy")
      assert.match(out.error.message, /exploding/)
      assert.equal(fetched, 0, "the call never left the gateway")
    },
  )
})

test("a quirk throwing while shaping the headers fails the same way", async () => {
  await withFetch(
    async () => {
      throw new Error("must not be reached")
    },
    async () => {
      const applied = { ...IDENT, headers: () => { throw new Error("exploding transformHeaders") } }
      const out = await upstream.callJson({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied, timeoutMs: 500 })
      assert.equal(out.ok, false)
      assert.equal(out.error.cupbearerVerdict.reason, "bad_quirks")
      assert.match(out.error.message, /exploding/)
    },
  )
})

test("a quirk throwing in openStream is a classified bad_quirks failure too", async () => {
  await withFetch(
    async () => {
      throw new Error("must not be reached")
    },
    async () => {
      const applied = { ...IDENT, request: () => { throw new Error("exploding transformRequest") } }
      const out = await upstream.openStream({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied, timeoutMs: 500 })
      assert.equal(out.ok, false)
      assert.equal(out.status, 0)
      assert.equal(out.error.cupbearerVerdict.reason, "bad_quirks")
      assert.equal(typeof out.abort, "function")
    },
  )
})

test("the upstream error body read is capped before it reaches the classifier", async () => {
  const CHUNK = "z".repeat(65536)
  let chunksSent = 0
  let cancelled = false
  await withFetch(
    async () => ({
      ok: false,
      status: 500,
      body: {
        getReader() {
          return {
            read: async () => {
              if (chunksSent >= 8) return { done: true } // 512KB on the wire
              chunksSent++
              return { done: false, value: new TextEncoder().encode(CHUNK) }
            },
            cancel: async () => {
              cancelled = true
            },
          }
        },
      },
    }),
    async () => {
      const out = await upstream.callJson({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied: IDENT, timeoutMs: 2000 })
      assert.equal(out.ok, false)
      assert.equal(typeof out.body, "string")
      assert.ok(out.body.length <= 262144, `error body capped, got ${out.body.length}`)
      assert.equal(cancelled, true, "the rest of the body is discarded, not drained")
    },
  )
})

test("a normal-size error body still parses as JSON", async () => {
  await withFetch(
    async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "rate limited" } }),
    }),
    async () => {
      const out = await upstream.callJson({ provider: PROVIDER, keyId: "p:key-1", model: "m", payload: PAYLOAD, applied: IDENT, timeoutMs: 2000 })
      assert.equal(out.ok, false)
      assert.equal(out.status, 429)
      assert.equal(out.body.error.message, "rate limited")
    },
  )
})
