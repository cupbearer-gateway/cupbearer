"use strict"
// DOC: ../docs/architecture.md → § Module map → server/events.js · ../docs/api.md → § SSE events

// In-process event bus + SSE fan-out for the dashboard.
//
// Two consumers: SSE clients (dashboard) and in-process listeners (notify.js,
// wired up in index.js). Both are deliberately fire-and-forget — a slow or
// wedged consumer must never apply backpressure to a live model request. SSE
// clients get a bounded queue; if it overflows, that client is dropped rather
// than allowed to stall the router.

const MAX_BUFFERED = 256

let nextId = 1
const clients = new Map() // id -> { res, dropped }
const listeners = new Map() // type -> [fn]

function subscribe(res) {
  const id = nextId++
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(": connected\n\n")
  clients.set(id, { res })

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n")
    } catch {
      cleanup()
    }
  }, 20000)

  function cleanup() {
    clearInterval(heartbeat)
    clients.delete(id)
  }

  res.on("close", cleanup)
  res.on("error", cleanup)
  return id
}

function emit(type, payload) {
  // In-process listeners first; a throwing listener must not kill the emit.
  for (const fn of listeners.get(type) || []) {
    try {
      fn(payload)
    } catch {
      /* listener bug must not take down the router */
    }
  }

  if (!clients.size) return
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const [id, client] of clients) {
    try {
      // writableLength grows when the socket cannot keep up.
      if (client.res.writableLength > MAX_BUFFERED * 1024) {
        client.res.destroy()
        clients.delete(id)
        continue
      }
      client.res.write(frame)
    } catch {
      clients.delete(id)
    }
  }
}

function clientCount() {
  return clients.size
}

function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, [])
  listeners.get(type).push(fn)
}

module.exports = { subscribe, emit, clientCount, on }
