"use strict"

// SSE fan-out safety. Two things must never take down a live model request:
// a payload that cannot serialise (a future circular ref must be skipped, not
// thrown into the request path), and a listener bug (already guarded). The
// in-process listeners must keep receiving raw payloads regardless.

const test = require("node:test")
const assert = require("node:assert")
const events = require("./events")

// Fake SSE response. subscribe() registers its cleanup on res "close" and its
// heartbeat interval is NOT unref'd — every subscribed fake MUST be closed
// (res.close() in a finally) or the test process hangs on the live interval.
function fakeSseRes() {
  const handlers = {}
  const res = {
    writableLength: 0,
    frames: [],
    writeHead() {},
    write(b) {
      res.frames.push(b)
      return true
    },
    destroy() {},
    on(ev, fn) {
      ;(handlers[ev] ||= []).push(fn)
      return res
    },
    // Fire the stored "close" handlers so subscribe()'s cleanup runs.
    close() {
      for (const fn of handlers.close || []) fn()
      return true
    },
  }
  return res
}

test("a payload that cannot serialise is skipped silently and the client stays subscribed", () => {
  const res = fakeSseRes()
  events.subscribe(res)
  try {
    const circular = { hello: 1 }
    circular.self = circular
    assert.doesNotThrow(() => events.emit("circular-test", circular))
    assert.equal(res.frames.length, 1, "only the connect frame — no data frame for the unserialisable payload")
    assert.equal(events.clientCount(), 1, "the client is still subscribed")
  } finally {
    res.close()
  }
})

test("a normal emit delivers the SSE event frame", () => {
  const res = fakeSseRes()
  events.subscribe(res)
  try {
    events.emit("normal-test", { hello: 1 })
    assert.equal(res.frames.length, 2)
    assert.equal(res.frames[0], ": connected\n\n")
    assert.equal(res.frames[1], `event: normal-test\ndata: {"hello":1}\n\n`)
  } finally {
    res.close()
  }
})

test("the in-process listener still receives the raw payload even when the SSE frame is skipped", () => {
  const seen = []
  const listener = (payload) => seen.push(payload)
  events.on("listener-test", listener)
  const res = fakeSseRes()
  events.subscribe(res)
  try {
    const circular = { n: 7 }
    circular.self = circular
    events.emit("listener-test", circular)
    assert.equal(seen.length, 1, "the listener fired exactly once")
    assert.equal(seen[0], circular, "the listener got the raw payload object, not a serialised copy")
    assert.equal(res.frames.length, 1, "the SSE fan-out was still skipped")
  } finally {
    events.off("listener-test", listener)
    res.close()
  }
})
