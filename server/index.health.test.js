"use strict"

// Boot e2e: spawn the real server as a child process on a scratch home and a
// free port, then check the HTTP behaviours that only exist once everything is
// wired: the machine-readable /health route, the /healthz Host allow-list, the
// DNS-rebinding guard on /api/*, and the stale .tmp sweep that clears crash
// litter from a previous run. node:http (not fetch) so the Host header can be
// overridden for the guard cases — undici does not reliably allow that.

const test = require("node:test")
const assert = require("node:assert")
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const VERSION = require("../package.json").version

function get(port, reqPath, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "GET", headers: hostHeader ? { host: hostHeader } : {} },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("boot e2e: /health, /healthz Host allow-list, rebinding guard, stale .tmp sweep", { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-health-e2e-"))
  // Crash litter a killed run could have left behind; sweepStaleTmp must clear
  // it on boot before any state rewrite.
  const litter = path.join(home, "health-state.json.99999.tmp")
  fs.writeFileSync(litter, "{}")

  // Grab a free port: bind, read the assigned port, release for the child.
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })

  const env = { ...process.env, CUPBEARER_HOME: home, CUPBEARER_PORT: String(port), CUPBEARER_HOST: "127.0.0.1" }
  delete env.CUPBEARER_ALLOW_LAN
  delete env.CUPBEARER_UI_DIST

  const child = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.resume()
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d))
  const tail = () => `\n--- child stderr ---\n${stderr.slice(-2000)}`

  try {
    // Poll until the gateway answers /health (default Host is fine here).
    let health = null
    let lastError = null
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        const r = await get(port, "/health")
        if (r.status === 200) {
          health = r
          break
        }
      } catch (e) {
        lastError = e
      }
      await sleep(100)
    }
    assert.ok(health, `server did not answer /health within 10s (last error: ${lastError?.message})`)

    assert.match(health.headers["content-type"], /application\/json/)
    const body = JSON.parse(health.body)
    assert.equal(body.ok, true)
    assert.equal(body.version, VERSION)
    assert.ok(Number.isInteger(body.uptimeSeconds), `uptimeSeconds should be an integer, got ${JSON.stringify(body.uptimeSeconds)}`)

    // A loopback name on the bound port is allowed.
    const healthz = await get(port, "/healthz", `localhost:${port}`)
    assert.equal(healthz.status, 200, `/healthz with Host localhost:${port} should be 200`)

    // A foreign Host is a DNS-rebinding browser — rejected before anything runs.
    const evil = await get(port, "/api/overview", `evil.example:${port}`)
    assert.equal(evil.status, 403, "foreign Host header must 403")
    assert.match(evil.headers["content-type"], /text\/plain/)

    // The boot sweep cleared the crash litter.
    assert.ok(!fs.existsSync(litter), "stale .tmp litter should have been swept on boot")
  } catch (e) {
    throw new Error(`${e.message}${tail()}`)
  } finally {
    child.kill()
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(2000)])
  }
})
