"use strict"

// Isolation: never touch the live gateway's real config dir — the running
// server writes the same files this suite does, and both would race.
process.env.CUPBEARER_HOME = require("node:os").tmpdir() + require("node:path").sep + "cupbearer-test-" + process.pid

const test = require("node:test")
const assert = require("node:assert")
const fs = require("fs")
const secrets = require("./secrets")
const { SECRETS_FILE } = require("./paths")

function cleanFiles() {
  for (const f of [SECRETS_FILE, `${SECRETS_FILE}.bak`]) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

test("mask hides short keys behind the first characters only", () => {
  secrets.reset()
  cleanFiles()
  secrets.setMany({
    // 11 chars: "sk-…" — nothing more.
    short: "sk-12345678",
    // 17 chars: first 7, NO tail (13-19 would reveal more than it hides).
    medium: "sk-1234567890abcd",
    // 29 chars: first 7 + last 5.
    long: "sk-kwi20CWHqq000000000CCy6X8Pb",
  })
  const short = secrets.mask("short")
  assert.ok(short.startsWith("sk-") && short.endsWith("…"))
  assert.ok(!short.includes("5678"))
  const medium = secrets.mask("medium")
  assert.ok(medium.startsWith("sk-1234") && medium.endsWith("…"))
  assert.ok(!medium.includes("abcd"), "a 13-19 char key must not show a tail")
  const long = secrets.mask("long")
  assert.ok(long.startsWith("sk-kwi2") && long.endsWith("6X8Pb"))
  assert.equal(secrets.mask("missing"), null)
})

test("persist keeps a one-generation .bak; a corrupt file recovers from it", () => {
  secrets.reset()
  cleanFiles()
  secrets.set("k1", "sk-first")
  assert.ok(!fs.existsSync(`${SECRETS_FILE}.bak`), "first save has nothing to back up")
  secrets.set("k2", "sk-second")
  assert.ok(fs.existsSync(`${SECRETS_FILE}.bak`))
  assert.deepEqual(JSON.parse(fs.readFileSync(`${SECRETS_FILE}.bak`, "utf8")), { k1: "sk-first" })

  fs.writeFileSync(SECRETS_FILE, "{corrupt")
  secrets.reset()
  assert.equal(secrets.get("k1"), "sk-first")
  assert.equal(secrets.get("k2"), null)
})

test("a corrupt secrets file with no .bak refuses to boot keyless", () => {
  secrets.reset()
  cleanFiles()
  fs.writeFileSync(SECRETS_FILE, "{corrupt")
  assert.throws(() => secrets.get("k1"), /unreadable/)
})
