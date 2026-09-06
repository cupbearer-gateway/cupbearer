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

module.exports = { json, error, readBody, readJsonBody }
