"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-api-test-" + process.pid

// Dashboard API: malformed JSON bodies must be a 400 answered to the client,
// never an unhandled throw (before the readJson guard these 500'd or crashed
// the request). Plus the key-rename race: a DELETE landing between route
// resolution and the config write must 404, not TypeError into a 500.

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")
const api = require("./api")

function fakeReq(rawBody) {
  const req = {
    on(ev, fn) {
      // Emit data+end synchronously, the way a small buffered body arrives.
      if (ev === "data") fn(Buffer.from(rawBody))
      if (ev === "end") fn()
      return req
    },
  }
  return req
}

function fakeRes() {
  const res = {
    headersSent: false,
    code: 0,
    body: "",
    writeHead(code) {
      res.code = code
      res.headersSent = true
    },
    end(b) {
      res.body = b
    },
  }
  return res
}

function call(method, path, rawBody) {
  const url = new URL(path, "http://127.0.0.1:4143")
  const res = fakeRes()
  const req = fakeReq(rawBody)
  req.method = method
  return { done: api.handle(req, res, url), res }
}

test("malformed JSON on POST /api/pools is a 400, not a crash", async () => {
  const { done, res } = call("POST", "/api/pools", "{ not json")
  const handled = await done
  assert.equal(handled, true)
  assert.equal(res.code, 400)
  assert.match(String(res.body), /invalid JSON body/)
})

test("malformed JSON on PUT /api/settings is a 400, not a crash", async () => {
  const { done, res } = call("PUT", "/api/settings", "nope{")
  const handled = await done
  assert.equal(handled, true)
  assert.equal(res.code, 400)
  assert.match(String(res.body), /invalid JSON body/)
})

function ensureAcme() {
  config.update((cfg) => {
    if (!cfg.providers.find((p) => p.id === "acme")) {
      cfg.providers.push({
        id: "acme",
        label: "Acme",
        baseURL: "https://acme.example/v1",
        models: ["m1"],
        keys: [{ id: "acme:key-1", label: "old", addedAt: new Date().toISOString() }],
      })
    }
  })
}

test("key PUT renames the key end to end", async () => {
  ensureAcme()
  const { done, res } = call("PUT", "/api/providers/acme/keys/acme%3Akey-1", JSON.stringify({ label: "renamed" }))
  const handled = await done
  assert.equal(handled, true)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.key.label, "renamed")
  assert.equal(config.getProvider("acme").keys[0].label, "renamed", "the rename persisted to config")
})

test("key PUT with a concurrent delete reports 404, not a 500", async () => {
  ensureAcme()
  const origUpdate = config.update
  try {
    // Simulate the key vanishing between route resolution (which saw the key)
    // and the write: the mutator runs against config state without it.
    config.update = (mutator) => mutator({ providers: [{ id: "acme", keys: [] }], pools: [], settings: {} })
    const { done, res } = call("PUT", "/api/providers/acme/keys/acme%3Akey-1", JSON.stringify({ label: "renamed" }))
    const handled = await done
    assert.equal(handled, true)
    assert.equal(res.code, 404)
    assert.equal(JSON.parse(res.body).error.message, 'no key "acme:key-1" on acme')
  } finally {
    config.update = origUpdate
  }
})
