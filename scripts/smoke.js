#!/usr/bin/env node
"use strict"
// End-to-end smoke test.
//
// Boots two stub OpenAI-compatible upstreams plus a real Cupbearer gateway
// against a throwaway home directory, then pushes traffic through the full
// stack (surface → router → relay → response). Requires no API keys and no
// network, so it runs anywhere — CI included:
//
//   node scripts/smoke.js        (or: npm run smoke)
//
// Exit code 0 = everything below passed.

const http = require("http")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

const ROOT = path.join(__dirname, "..")

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { "content-type": "application/json" })
  res.end(text)
}

// A stub upstream: /models lists one model; /chat/completions either always
// 500s (mode "fail", to exercise failover) or answers JSON and SSE correctly.
function startStub(mode) {
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      return json(res, 200, { object: "list", data: [{ id: "stub-model", object: "model" }] })
    }
    const body = JSON.parse((await readBody(req)) || "{}")
    if (mode === "fail") {
      return json(res, 500, { error: { message: "stub upstream exploded: degraded backend" } })
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const frame = (delta, finish) =>
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-model",
            choices: [{ index: 0, delta, logprobs: null, finish_reason: finish ?? null }],
          })}\n\n`,
        )
      frame({ role: "assistant", content: "he" })
      frame({ content: "llo" })
      frame({}, "stop")
      res.write("data: [DONE]\n\n")
      return res.end()
    }
    return json(res, 200, {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "hello from stub" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {}
    if (Date.now() > deadline) throw new Error(`gateway did not come up at ${url}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cupbearer-smoke-"))

  const stubA = await startStub("fail") // first leg: always 500 → must be failed over
  const stubB = await startStub("ok") // second leg: healthy

  const keyRec = (id) => ({ id, label: id })
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(
      {
        version: 1,
        providers: [
          { id: "stub-a", label: "Stub A", baseURL: `http://127.0.0.1:${stubA.port}`, adapter: "openai", quirks: [], models: ["stub-model"], keys: [keyRec("stub-a:key-1")] },
          { id: "stub-b", label: "Stub B", baseURL: `http://127.0.0.1:${stubB.port}`, adapter: "openai", quirks: [], models: ["stub-model"], keys: [keyRec("stub-b:key-1")] },
        ],
        pools: [
          {
            id: "demo",
            name: "Demo",
            keyStrategy: "round-robin",
            legs: [
              { providerId: "stub-a", model: "stub-model" },
              { providerId: "stub-b", model: "stub-model" },
            ],
          },
        ],
        settings: { notifyFailover: false, reviveProbe: false, canaryEnabled: false, metricsRetainDays: 1 },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(home, "secrets.json"),
    JSON.stringify({ "stub-a:key-1": "sk-stub-a", "stub-b:key-1": "sk-stub-b" }, null, 2),
  )

  const gwPort = 40000 + Math.floor(Math.random() * 20000)
  const base = `http://127.0.0.1:${gwPort}`
  const gw = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, CUPBEARER_HOME: home, CUPBEARER_PORT: String(gwPort) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  gw.stderr.on("data", (d) => process.stderr.write(`[gateway] ${d}`))

  try {
    await waitFor(`${base}/healthz`, 15000)
    console.log("gateway is up")

    // 1. models listing
    const models = await (await fetch(`${base}/v1/models`)).json()
    check("GET /v1/models lists the configured pool", models.data?.[0]?.id === "demo", JSON.stringify(models.data))

    // 2. non-streaming: first leg 500s, gateway fails over to the second
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: "hi" }] }),
    })
    const b1 = await r1.json()
    check("non-stream completion succeeds after failover", r1.status === 200, `status ${r1.status} ${JSON.stringify(b1).slice(0, 200)}`)
    check("response content comes from the healthy stub", b1.choices?.[0]?.message?.content === "hello from stub", JSON.stringify(b1.choices?.[0]))
    check("pool id is reported back as the model", b1.model === "demo", b1.model)
    check("attempt count reflects the failover", r1.headers.get("x-cupbearer-attempts") === "2", r1.headers.get("x-cupbearer-attempts"))
    check("serving provider is exposed in a response header", r1.headers.get("x-cupbearer-provider") === "stub-b", r1.headers.get("x-cupbearer-provider"))

    // 3. streaming through the relay
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "demo", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await r2.text()
    const assembled = [...text.matchAll(/"delta":\s*(\{[^}]*\})/g)]
      .map((m) => {
        try {
          return JSON.parse(m[1]).content || ""
        } catch {
          return ""
        }
      })
      .join("")
    check("streamed completion returns SSE", r2.status === 200 && text.includes("data: [DONE]"), `status ${r2.status}`)
    check("stream content assembles correctly", assembled === "hello", JSON.stringify(assembled))
    check("stream headers name the serving model", r2.headers.get("x-cupbearer-model") === "stub-model", r2.headers.get("x-cupbearer-model"))

    // 4. unknown model surfaces a readable 404
    const r3 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    })
    check("unknown model is a 404 with the pool list", r3.status === 404, `status ${r3.status}`)
  } finally {
    gw.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 500))
    stubA.server.close()
    stubB.server.close()
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {}
  }

  if (failures) {
    console.error(`\nsmoke test: ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nsmoke test: all checks passed")
}

main().catch((e) => {
  console.error("smoke test crashed:", e)
  process.exit(1)
})
