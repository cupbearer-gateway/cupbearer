"use strict"

// The Host allow-list is the gateway's DNS-rebinding / CSRF guard: only its own
// loopback names on the bound port may appear in the Host header, because a
// webpage can point a foreign domain at 127.0.0.1 and read keys through the
// unauthenticated API. Also: error() must never write into an already-destroyed
// socket — the client may hang up mid-dispatch, and writing into that socket is
// noise, not an answer.

const test = require("node:test")
const assert = require("node:assert")
const { isAllowedHost, error } = require("./http-util")

const BOUND = ["127.0.0.1", 4143]

test("isAllowedHost accepts the gateway's own loopback names on the bound port", () => {
  const allowed = [
    "127.0.0.1:4143",
    "localhost:4143",
    "[::1]:4143",
    "LOCALHOST:4143", // Host names are case-insensitive in practice
    "  127.0.0.1:4143  ", // tolerate stray whitespace
  ]
  for (const host of allowed) {
    assert.equal(isAllowedHost(host, ...BOUND), true, JSON.stringify(host))
  }
})

test("isAllowedHost rejects foreign names, wrong ports and malformed headers", () => {
  const rejected = [
    "evil.example:4143", // foreign domain: rebinding attempt
    "127.0.0.1:9999", // right host, wrong port
    "127.0.0.1", // no port at all
    "", // empty
    undefined, // absent
    "localhost.evil.com:4143", // suffix look-alike
    "[::1]:80", // loopback host, wrong port
  ]
  for (const host of rejected) {
    assert.equal(isAllowedHost(host, ...BOUND), false, JSON.stringify(host))
  }
})

test("error() refuses to write into an already-destroyed socket", () => {
  const destroyedRes = {
    destroyed: true,
    writeHead: () => assert.fail("writeHead must not be called on a destroyed res"),
    end: () => assert.fail("end must not be called on a destroyed res"),
  }
  error(destroyedRes, 400, "boom")

  const socketDestroyedRes = {
    socket: { destroyed: true },
    writeHead: () => assert.fail("writeHead must not be called when the socket is destroyed"),
    end: () => assert.fail("end must not be called when the socket is destroyed"),
  }
  error(socketDestroyedRes, 400, "boom")

  // A live response still receives the JSON error body.
  let code = 0
  let body = ""
  const liveRes = {
    writeHead(c) {
      code = c
    },
    end(b) {
      body = b
    },
  }
  error(liveRes, 409, "nope", { hint: "try again" })
  assert.equal(code, 409)
  const parsed = JSON.parse(body)
  assert.equal(parsed.error.message, "nope")
  assert.equal(parsed.error.type, "cupbearer_error")
  assert.equal(parsed.error.hint, "try again")
})
