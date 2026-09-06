"use strict"
// DOC: ../docs/operations.md → § Running · § Autostart at logon · ../docs/architecture.md → § Process model

// Cupbearer entry point.
//
// One process, one port. Serves three things:
//   /v1/*     OpenAI-compatible surface for any client
//   /api/*    dashboard REST + SSE
//   /*        the prebuilt dashboard bundle
//
// SECURITY: binds 127.0.0.1 only, and there is no authentication. This process
// holds every upstream API key, so the loopback bind IS the security boundary.
// Do not change HOST to 0.0.0.0 — that would expose every key to the network.

const http = require("http")
const fs = require("fs")
const path = require("path")

const { PORT, HOST, UI_DIST, ROOT } = require("./paths")
const config = require("./config")
const metrics = require("./metrics")
const notify = require("./notify")
const revive = require("./revive")
const canary = require("./canary")
const events = require("./events")
const api = require("./api")
const surface = require("./openai-surface")
const anthropic = require("./anthropic-surface")
const { json, error } = require("./http-util")

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function serveStatic(req, res, url) {
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
  const target = path.join(UI_DIST, rel)

  // Refuse to serve outside the bundle directory.
  if (!path.resolve(target).startsWith(path.resolve(UI_DIST))) {
    return error(res, 403, "forbidden")
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      // SPA fallback so client-side routes work on reload.
      const index = path.join(UI_DIST, "index.html")
      return fs.readFile(index, (e2, html) => {
        if (e2) {
          return error(
            res,
            503,
            "dashboard bundle not built yet. The API and /v1 surface are running; build the UI to use the dashboard.",
          )
        }
        res.writeHead(200, { "content-type": MIME[".html"] })
        res.end(html)
      })
    }
    const ext = path.extname(target).toLowerCase()
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      // Hashed asset names make long caching safe; index.html must not be cached.
      "cache-control": rel === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    })
    res.end(buf)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  try {
    // ---- OpenAI surface ---------------------------------------------------
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      if (req.method !== "GET") return error(res, 405, "method not allowed")
      return surface.listModels(res)
    }
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") return error(res, 405, "method not allowed")
      return await surface.chatCompletions(req, res)
    }
    if (url.pathname === "/v1/messages") {
      if (req.method !== "POST") return error(res, 405, "method not allowed")
      return await anthropic.messages(req, res)
    }

    // ---- health check -----------------------------------------------------
    if (url.pathname === "/healthz") {
      const cfg = config.load()
      return json(res, 200, {
        ok: true,
        pools: cfg.pools.length,
        providers: cfg.providers.length,
        uptimeSeconds: Math.round(process.uptime()),
      })
    }

    // ---- dashboard API ----------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      const handled = await api.handle(req, res, url)
      if (!handled) return error(res, 404, `no such API route: ${req.method} ${url.pathname}`)
      return
    }

    // ---- dashboard bundle -------------------------------------------------
    if (req.method !== "GET") return error(res, 405, "method not allowed")
    return serveStatic(req, res, url)
  } catch (e) {
    if (!res.headersSent) return error(res, 500, `cupbearer: ${e.message}`)
    try {
      res.end()
    } catch {}
  }
})

server.on("error", (e) => {
  const logDir = path.join(ROOT, "logs")
  const bootLine = `${new Date().toISOString()} START FAILED: ${e.code === "EADDRINUSE" ? `port ${PORT} already in use — another instance is running` : e.message}\n`
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, "boot.log"), bootLine, "utf8")
  } catch {}
  console.error(`[cupbearer] ${bootLine.trim()}`)
  process.exit(1)
})

// Never let one bad request kill the gateway.
process.on("uncaughtException", (e) => {
  console.error("[cupbearer] uncaught:", e.stack || e.message)
})
process.on("unhandledRejection", (e) => {
  console.error("[cupbearer] unhandled rejection:", e?.stack || e)
})

function shutdown() {
  metrics.shutdown()
  revive.stop()
  canary.stop()
  server.close(() => process.exit(0))
  // Do not hang forever on lingering keep-alive sockets.
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// Fail fast and loudly on a broken config rather than starting half-working.
try {
  // Security boundary validation: loopback by default.
  const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1"
  if (!isLoopback && process.env.CUPBEARER_ALLOW_LAN !== "1") {
    console.error(`[cupbearer] FATAL: host "${HOST}" is non-loopback. Cupbearer holds API keys without HTTP auth.`)
    console.error(`[cupbearer] To allow LAN binding, set CUPBEARER_ALLOW_LAN=1 explicitly.`)
    process.exit(1)
  }

  const cfg = config.load()
  server.listen(PORT, HOST, () => {
    console.log(`[cupbearer] http://${HOST}:${PORT}  (dashboard + /v1 surface)`)
    console.log(`[cupbearer] ${cfg.pools.length} pool(s), ${cfg.providers.length} provider(s), root ${ROOT}`)
    if (!fs.existsSync(path.join(UI_DIST, "index.html"))) {
      console.log("[cupbearer] dashboard bundle not present yet — API is live, UI pending build")
    }
    // Desktop toasts whenever a request switches key or provider, or a pool
    // goes down; throttled inside notify.
    events.on("provider_failover", (d) => {
      notify.maybe({ key: d.key || `${d.poolId}:${d.providerId}`, title: d.title, message: d.message })
    })
    // Boot trace: lets us confirm at a glance that the logon autostart worked.
    try {
      const logDir = path.join(ROOT, "logs")
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(
        path.join(logDir, "boot.log"),
        `${new Date().toISOString()} listening on ${HOST}:${PORT} (pools=${cfg.pools.length}) pid=${process.pid}\n`,
        "utf8",
      )
    } catch {}
    revive.start()
    canary.start()
    metrics.scheduleRetention()
  })
} catch (e) {
  console.error(`[cupbearer] refusing to start: ${e.message}`)
  process.exit(1)
}
