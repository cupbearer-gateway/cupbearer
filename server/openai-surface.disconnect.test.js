"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-disc-test-" + process.pid

// The client-disconnect contract: hanging up mid-dispatch aborts the router's
// signal (stop paying for the upstream call — the user pressed escape), while a
// normally completed response must NOT spuriously abort when the socket's
// close event arrives afterwards. Regression guard for the res.on("close")
// listener (req "close" on Node >=16 fires on finished body reads, so it never
// signalled a real hang-up).

const test = require("node:test")
const assert = require("node:assert")
const { PassThrough } = require("node:stream")
const config = require("./config")
const router = require("./router")
const surface = require("./openai-surface")

const POOL = { id: "p", name: "P", keyStrategy: "round-robin", legs: [{ providerId: "a", model: "m" }] }

function fakeRes() {
  const handlers = {}
  const res = {
    headersSent: false,
    writableEnded: false,
    on(ev, fn) {
      ;(handlers[ev] ||= []).push(fn)
      return res
    },
    emit(ev) {
      for (const fn of handlers[ev] || []) fn()
      return true
    },
    writeHead(code) {
      res.headersSent = true
      res.code = code
    },
    write() {
      return true
    },
    end() {
      res.writableEnded = true
    },
  }
  return res
}

// The body read and dispatch happen on stream ticks; poll setImmediate until
// the condition holds, with a bounded budget so a broken pipeline fails fast.
async function until(ready, what, maxTicks = 50) {
  for (let i = 0; i < maxTicks && !ready(); i++) await new Promise((r) => setImmediate(r))
  if (!ready()) throw new Error(`gave up waiting for ${what}`)
}

function stubConfig() {
  config.load = () => ({ settings: {}, pools: [POOL], providers: [] })
  config.getPool = (id) => (id === "p" ? POOL : null)
}

test("a client hang-up mid-dispatch aborts the router signal", async () => {
  const orig = { load: config.load, getPool: config.getPool, dispatch: router.dispatch }
  const captured = { signal: null }
  let release = null
  try {
    stubConfig()
    const hang = new Promise((resolve) => {
      release = () => resolve({ exhausted: true, attempts: [] })
    })
    router.dispatch = async ({ signal }) => {
      captured.signal = signal
      return hang
    }

    const req = new PassThrough()
    const res = fakeRes()
    const done = surface.chatCompletions(req, res)
    req.end(JSON.stringify({ model: "p", messages: [] }))
    await until(() => captured.signal, "the dispatch call")

    // The user pressed escape: the socket closes while nothing has been
    // written back yet.
    res.emit("close")
    assert.equal(captured.signal.aborted, true, "close before completion must abort the dispatch signal")

    release()
    await done
  } finally {
    if (release) release()
    config.load = orig.load
    config.getPool = orig.getPool
    router.dispatch = orig.dispatch
  }
})

test("a normal completion does not spuriously abort on the later close event", async () => {
  const orig = { load: config.load, getPool: config.getPool, dispatch: router.dispatch }
  const captured = { signal: null }
  try {
    stubConfig()
    router.dispatch = async ({ signal, res: r }) => {
      captured.signal = signal
      // Commit the response the way a real upstream relay would.
      r.writeHead(200, { "content-type": "application/json" })
      r.end(JSON.stringify({ choices: [] }))
      return { committed: true, attempts: [] }
    }

    const req = new PassThrough()
    const res = fakeRes()
    const done = surface.chatCompletions(req, res)
    req.end(JSON.stringify({ model: "p", messages: [] }))
    await until(() => captured.signal, "the dispatch call")
    await done

    // The socket close event arrives after the response was fully written.
    res.emit("close")
    assert.equal(res.writableEnded, true, "the response was committed")
    assert.equal(captured.signal.aborted, false, "close after a committed response must not abort")
  } finally {
    config.load = orig.load
    config.getPool = orig.getPool
    router.dispatch = orig.dispatch
  }
})
