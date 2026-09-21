"use strict"
// DOC: ../docs/architecture.md → § Module map → server/secrets.js

// Secrets store: { keyId: "sk-..." }.
//
// Kept in a separate file from config.json so the config stays diffable and
// pasteable without leaking credentials. On Windows we tighten the ACL to the
// current user only; elsewhere we chmod 600. Writes are durable-atomic (temp
// file → fsync → rename) with a one-generation secrets.json.bak kept under the
// same ACL as the main file, so a corrupt secrets file boots from the backup
// instead of silently coming up with no keys.
//
// Nothing in this module ever returns a full key value to the HTTP layer —
// callers that need the real value are the outbound request path only. The
// dashboard gets mask() output.

const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { SECRETS_FILE } = require("./paths")

let cache = null

// Durable atomic write: fsync the temp file before the rename (a plain
// write+rename can land a truncated file past the rename on power loss) and
// keep a one-generation .bak of the previous file for boot-time recovery.
function writeDurable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, "utf8")
  const fd = fs.openSync(tmp, "r+")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.copyFileSync(file, `${file}.bak`)
  } catch {} // first save: nothing to back up yet
  fs.renameSync(tmp, file)
}

function lockDown(file) {
  try {
    if (process.platform === "win32") {
      // USERNAME is unset in some service contexts; os.userInfo() reads the
      // account from the process token instead of the environment.
      const user = process.env.USERNAME || os.userInfo().username
      if (!user) {
        console.error(`cupbearer: could not resolve the current user — leaving default perms on ${file}`)
        return false
      }
      // Grant FIRST, then strip inheritance: a failed grant leaves the default
      // (inherited) ACEs intact, while strip-then-grant can leave a file with
      // no ACEs at all — unreadable by everyone.
      execFileSync("icacls", [file, "/grant:r", `${user}:(F)`], { stdio: "ignore" })
      execFileSync("icacls", [file, "/inheritance:r"], { stdio: "ignore" })
    } else {
      fs.chmodSync(file, 0o600)
    }
    return true
  } catch {
    // Non-fatal: the file is still inside the user profile. Never leave it in
    // a worse state than the default perms — skip the lockdown.
    console.error(`cupbearer: could not lock down ${file} — leaving default perms`)
    return false
  }
}

// Parse a secrets file. undefined = missing; null = present but unreadable.
function parse(file) {
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return undefined
    return null
  }
  try {
    return JSON.parse(raw) || {}
  } catch {
    return null
  }
}

function load() {
  if (cache) return cache
  const main = parse(SECRETS_FILE)
  if (main !== null) {
    cache = main || {} // missing file boots empty
    return cache
  }
  // Present but unreadable: fall back to the one-generation backup before
  // failing — the alternative is booting with no keys at all, silently.
  const bak = parse(`${SECRETS_FILE}.bak`)
  if (bak) {
    console.error(`cupbearer: ${SECRETS_FILE} is unreadable — recovered from ${SECRETS_FILE}.bak`)
    cache = bak
    return cache
  }
  throw new Error(`cupbearer: ${SECRETS_FILE} unreadable, and ${SECRETS_FILE}.bak has no usable copy`)
}

function persist(next) {
  writeDurable(SECRETS_FILE, JSON.stringify(next, null, 2) + "\n")
  lockDown(SECRETS_FILE)
  // The recovery copy holds the same secrets — same lockdown as the main file.
  // (Absent until the second save, so don't point icacls at thin air.)
  if (fs.existsSync(`${SECRETS_FILE}.bak`)) lockDown(`${SECRETS_FILE}.bak`)
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

// "sk-kwi20CWH...CCy6X8Pb" -> "sk-kwi2…6X8Pb". The 5-char tail only pays off
// on long keys: below 20 chars it would reveal more than it hides.
function mask(keyId) {
  const v = get(keyId)
  if (!v) return null
  if (v.length <= 12) return `${v.slice(0, 3)}…`
  if (v.length < 20) return `${v.slice(0, 7)}…`
  return `${v.slice(0, 7)}…${v.slice(-5)}`
}

function reset() {
  cache = null
}

module.exports = { get, set, setMany, remove, has, mask, reset, lockDown }
