"use strict"
// DOC: ../docs/architecture.md → § Module map → server/notify.js

// notify.js is the throttle in front of scripts/toast.ps1. These tests pin the
// throttle behaviour: on/off switch, per-source cooldown, and the global gap
// that stops a busy pool from spamming the Action Center. The actual spawn is
// stubbed — no toast is fired during the test run.

const test = require("node:test")
const assert = require("node:assert")
const cp = require("child_process")
const path = require("path")
const config = require("./config")
const notify = require("./notify")

let spawnCalls = []

function fakeConfig(settings) {
  const orig = config.load
  config.load = () => ({ settings: { ...settings } })
  return orig
}

function installSpawnStub() {
  const orig = cp.spawn
  spawnCalls = []
  cp.spawn = (...args) => {
    spawnCalls.push(args)
    return { on() {}, unref() {} }
  }
  return orig
}

test.beforeEach(() => {
  notify._reset()
  notify._setMinGap(2000)
})

test("disabled setting suppresses the toast", () => {
  const restoreCfg = fakeConfig({ notifyFailover: false })
  const restoreSpawn = installSpawnStub()
  test.after(() => {
    config.load = restoreCfg
    cp.spawn = restoreSpawn
  })

  const fired = notify.maybe({ key: "p:x", title: "t", message: "m" })
  assert.strictEqual(fired, false)
  assert.strictEqual(spawnCalls.length, 0)
})

test("enabled setting fires a toast via powershell", () => {
  const restoreCfg = fakeConfig({ notifyFailover: true, notifyCooldownMinutes: 10 })
  const restoreSpawn = installSpawnStub()
  test.after(() => {
    config.load = restoreCfg
    cp.spawn = restoreSpawn
  })

  const fired = notify.maybe({ key: "p:x", title: "Key out of action", message: `"A" is out of quota` })
  assert.strictEqual(fired, true)
  assert.strictEqual(spawnCalls.length, 1)

  const [exe, args, opts] = spawnCalls[0]
  assert.strictEqual(exe, "powershell.exe")
  assert.ok(args.some((a) => path.basename(a) === "toast.ps1"))
  assert.ok(args.includes("-WindowStyle") && args.includes("Hidden"))
  assert.strictEqual(opts.env.CB_TOAST_TITLE, "Key out of action")
  assert.strictEqual(opts.env.CB_TOAST_MESSAGE, `"A" is out of quota`)
  assert.strictEqual(opts.windowsHide, true)
})

test("global gap: a second toast inside 2s is dropped even for a different source", () => {
  const restoreCfg = fakeConfig({ notifyFailover: true, notifyCooldownMinutes: 10 })
  const restoreSpawn = installSpawnStub()
  test.after(() => {
    config.load = restoreCfg
    cp.spawn = restoreSpawn
  })

  assert.strictEqual(notify.maybe({ key: "a:x", title: "t", message: "m" }), true)
  assert.strictEqual(notify.maybe({ key: "b:y", title: "t", message: "m" }), false)
  assert.strictEqual(spawnCalls.length, 1)
})

test("per-source cooldown: same key is throttled, different keys pass with no gap", () => {
  const restoreCfg = fakeConfig({ notifyFailover: true, notifyCooldownMinutes: 10 })
  const restoreSpawn = installSpawnStub()
  test.after(() => {
    config.load = restoreCfg
    cp.spawn = restoreSpawn
  })

  notify._setMinGap(0)

  assert.strictEqual(notify.maybe({ key: "a:x", title: "t", message: "m" }), true)
  assert.strictEqual(notify.maybe({ key: "b:y", title: "t", message: "m" }), true)
  assert.strictEqual(notify.maybe({ key: "a:x", title: "t", message: "m" }), false) // cooldown
  assert.strictEqual(spawnCalls.length, 2)
})

test("spawn error is swallowed, not thrown", () => {
  const restoreCfg = fakeConfig({ notifyFailover: true, notifyCooldownMinutes: 10 })
  const restoreSpawn = installSpawnStub()
  test.after(() => {
    config.load = restoreCfg
    cp.spawn = restoreSpawn
  })

  cp.spawn = () => {
    throw new Error("no powershell")
  }
  assert.strictEqual(notify.maybe({ key: "a:x", title: "t", message: "m" }), false)
})
