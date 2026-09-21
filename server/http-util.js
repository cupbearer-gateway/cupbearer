"use strict"
// DOC: ../docs/api.md → § Dashboard API

// Small HTTP helpers shared by the API and the model surface.

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function error(res, status, message, extra = {}) {
  // The connection may already be gone (readBody destroys an over-limit body;
  // the client may hang up mid-dispatch) — writing a reply into that socket is
  // noise, not an answer.
  if (res.destroyed || res.socket?.destroyed) return
  json(res, status, { error: { message, type: "cupbearer_error", ...extra } })
}

function readBody(req, { limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  return JSON.parse(buf.toString("utf8"))
}

// Host allow-list for the loopback-bound gateway: only its own loopback names
// on the bound port may appear in the Host header. Anything else is a browser
// doing DNS rebinding (a foreign domain pointed at 127.0.0.1), not a local
// client — it must never reach the unauthenticated, key-holding API.
function isAllowedHost(hostHeader, boundHost, boundPort) {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false
  let host = hostHeader.trim().toLowerCase()
  let port = ""
  if (host.startsWith("[")) {
    const end = host.indexOf("]")
    if (end === -1) return false
    port = host.slice(end + 1)
    host = host.slice(1, end)
  } else {
    const colon = host.lastIndexOf(":")
    if (colon !== -1) {
      port = host.slice(colon)
      host = host.slice(0, colon)
    }
  }
  const names = new Set(["127.0.0.1", "localhost", "::1"])
  names.add(String(boundHost || "").toLowerCase())
  return port === `:${boundPort}` && names.has(host)
}

module.exports = { json, error, readBody, readJsonBody, isAllowedHost }
