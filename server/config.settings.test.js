"use strict"

const test = require("node:test")
const assert = require("node:assert")
const config = require("./config")

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
