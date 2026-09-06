"use strict"
// DOC: ../docs/operations.md → § Desktop notifications · ../docs/architecture.md → § Module map → server/notify.js

// Desktop notifications for failover events.
//
// Fires a Windows toast when a pool leg drops out and the router falls
// to the next provider. The actual OS work happens in scripts/toast.ps1; this
// module only decides WHEN to fire and throttles so a busy pool cannot spam the
// Action Center:
//
//   - per-source cooldown   one toast per (pool, provider) per N minutes
//   - global gap            never more often than every 2s, whatever the source
//
// Fire-and-forget: a stuck powershell.exe must never stall the router, so the
// child is spawned detached, its handles are ignored, and spawn errors (no
// powershell on PATH) are swallowed. An offline or headless box simply gets no
// toasts and the router never notices.

const cp = require("child_process")
const path = require("path")
const config = require("./config")

const TOAST_SCRIPT = path.join(__dirname, "..", "scripts", "toast.ps1")

// Deliberately module-level: survive config reloads, bounded by prune().
const lastSeen = new Map() // `${poolId}:${providerId}` -> last toast timestamp
let globalLast = 0
let minGapMs = 2000

function enabled() {
  return config.load().settings.notifyFailover !== false
}

/**
 * Maybe fire a toast. Returns true if one was dispatched.
 * @param {object} opts
 * @param {string} opts.key      `${poolId}:${providerId}` — cooldown identity
 * @param {string} opts.title    toast title
 * @param {string} opts.message  toast body
 */
function maybe({ key, title, message }) {
  if (!enabled()) return false
  const now = Date.now()
  if (now - globalLast < minGapMs) return false

  const cooldownMs = (config.load().settings.notifyCooldownMinutes || 10) * 60000
  const last = lastSeen.get(key)
  if (last && now - last < cooldownMs) return false

  lastSeen.set(key, now)
  globalLast = now
  prune()

  try {
    const child = cp.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", TOAST_SCRIPT],
      {
        env: { ...process.env, CB_TOAST_TITLE: title, CB_TOAST_MESSAGE: message },
        windowsHide: true,
        stdio: "ignore",
      },
    )
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

// Bound the cooldown map; drop anything older than a day. Cheap enough to run
// on every notify, and only touches the map once it is past 256 entries.
function prune() {
  if (lastSeen.size < 256) return
  const cutoff = Date.now() - 86400000
  for (const [k, t] of lastSeen) if (t < cutoff) lastSeen.delete(k)
}

// Test hooks.
function _reset() {
  lastSeen.clear()
  globalLast = 0
}
function _setMinGap(ms) {
  minGapMs = ms
}

module.exports = { maybe, enabled, _reset, _setMinGap }
