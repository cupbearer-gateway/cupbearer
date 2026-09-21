"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const config = require("./config")
const { CONFIG_FILE } = require("./paths")

const MIN_PROVIDER = { id: "p1", label: "A", baseURL: "http://127.0.0.1:9/v1", models: ["m"], keys: [] }

function cleanConfigFiles() {
  for (const f of [CONFIG_FILE, `${CONFIG_FILE}.bak`]) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

test("validate rejects unknown settings keys", () => {
  const cfg = config.load()
  const bad = JSON.parse(JSON.stringify(cfg))
  bad.settings.unknownKey = "hello"
  const errors = config.validate(bad)
  assert.ok(errors.some((e) => e.includes("unknown setting")))
})

test("validate rejects out-of-range timeout values", () => {
  const cfg = config.load()
  const bad = JSON.parse(JSON.stringify(cfg))
  bad.settings.attemptTimeoutMs = 200
  const errors = config.validate(bad)
  assert.ok(errors.some((e) => e.includes("attemptTimeoutMs")))
})

test("validate rejects attemptTimeoutMs exceeding requestBudgetMs", () => {
  const cfg = config.load()
  const bad = JSON.parse(JSON.stringify(cfg))
  bad.settings.attemptTimeoutMs = 120000
  bad.settings.requestBudgetMs = 60000
  const errors = config.validate(bad)
  assert.ok(errors.some((e) => e.includes("attemptTimeoutMs cannot exceed")))
})

test("validate accepts valid settings modifications", () => {
  const cfg = config.load()
  const valid = JSON.parse(JSON.stringify(cfg))
  valid.settings.maxKeysPerLeg = 10
  valid.settings.canaryEnabled = true
  const errors = config.validate(valid)
  assert.equal(errors.length, 0)
})

// ---- durable writes + .bak recovery -----------------------------------------

test("save keeps a one-generation .bak of the previous config", () => {
  config.reset()
  cleanConfigFiles()
  const v1 = config.load()
  v1.providers.push({ ...MIN_PROVIDER })
  config.save(v1)
  const v2 = config.load()
  v2.providers[0].label = "B"
  config.save(v2)
  assert.ok(fs.existsSync(`${CONFIG_FILE}.bak`))
  assert.equal(JSON.parse(fs.readFileSync(`${CONFIG_FILE}.bak`, "utf8")).providers[0].label, "A")
  assert.equal(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).providers[0].label, "B")
})

test("a corrupt main config boots from the .bak", () => {
  config.reset()
  cleanConfigFiles()
  const v1 = config.load()
  v1.providers.push({ ...MIN_PROVIDER })
  config.save(v1)
  config.save({ ...v1, providers: [] }) // .bak now holds the provider, main does not
  fs.writeFileSync(CONFIG_FILE, "not json {")
  config.reset()
  assert.equal(config.load().providers[0].label, "A")
})

test("load() refuses a wrong-shape config exactly like a parse error", () => {
  config.reset()
  cleanConfigFiles()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, providers: "x", pools: [] }))
  config.reset()
  assert.throws(() => config.load(), /unreadable/)
})

test("a wrong-shape config recovers from the .bak", () => {
  config.reset()
  cleanConfigFiles()
  const v1 = config.load()
  v1.providers.push({ ...MIN_PROVIDER })
  config.save(v1)
  config.save({ ...v1, providers: [] })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, providers: "x", pools: [] }))
  config.reset()
  assert.equal(config.load().providers[0].label, "A")
})

test("a corrupt config with no .bak still refuses to boot", () => {
  config.reset()
  cleanConfigFiles()
  fs.writeFileSync(CONFIG_FILE, "not json {")
  config.reset()
  assert.throws(() => config.load(), /unreadable/)
})
