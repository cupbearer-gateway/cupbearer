"use strict"
// DOC: ../docs/architecture.md → § Module map → server/secrets.js

// Secrets store: { keyId: "sk-..." }.
//
// Kept in a separate file from config.json so the config stays diffable and
// pasteable without leaking credentials. On Windows we tighten the ACL to the
// current user only; elsewhere we chmod 600.
//
// Nothing in this module ever returns a full key value to the HTTP layer —
// callers that need the real value are the outbound request path only. The
// dashboard gets mask() output.

const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")
const { SECRETS_FILE } = require("./paths")

let cache = null

function lockDown(file) {
  try {
    if (process.platform === "win32") {
      // Remove inherited ACEs, grant only the current user full control.
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(F)`], {
        stdio: "ignore",
      })
    } else {
      fs.chmodSync(file, 0o600)
    }
  } catch {
    // Non-fatal: the file is still inside the user profile. Surfaced by doctor().
  }
}

function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"))
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cupbearer: ${SECRETS_FILE} unreadable: ${e.message}`)
    cache = {}
  }
  return cache
}

function persist(next) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true })
  const tmp = `${SECRETS_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, SECRETS_FILE)
  lockDown(SECRETS_FILE)
  cache = next
}

function get(keyId) {
  return load()[keyId] ?? null
}

function set(keyId, value) {
  const next = { ...load(), [keyId]: String(value).trim() }
  persist(next)
}

function setMany(entries) {
  const next = { ...load() }
  for (const [id, value] of Object.entries(entries)) next[id] = String(value).trim()
  persist(next)
}

function remove(keyId) {
  const next = { ...load() }
  delete next[keyId]
  persist(next)
}

function has(keyId) {
  return Object.prototype.hasOwnProperty.call(load(), keyId)
}

// "sk-kwi20CWH...CCy6X8Pb" -> "sk-kwi2…6X8Pb"
function mask(keyId) {
  const v = get(keyId)
  if (!v) return null
  if (v.length <= 12) return `${v.slice(0, 3)}…`
  return `${v.slice(0, 7)}…${v.slice(-5)}`
}

function reset() {
  cache = null
}

module.exports = { get, set, setMany, remove, has, mask, reset, lockDown }
