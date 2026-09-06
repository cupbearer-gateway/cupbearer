"use strict"
// DOC: ../docs/architecture.md → § Module map → server/paths.js

// Single source of truth for where everything lives on disk.

const os = require("os")
const path = require("path")

const HOME = os.homedir()
const ROOT = process.env.CUPBEARER_HOME || path.join(HOME, ".config", "cupbearer")

module.exports = {
  HOME,
  ROOT,

  // Pools + providers, no secrets. Safe to read, diff, share.
  CONFIG_FILE: path.join(ROOT, "config.json"),
  // Key values only, keyed by key id. Locked down at write time.
  SECRETS_FILE: path.join(ROOT, "secrets.json"),
  // Request/call log (SQLite from M3; JSONL until then).
  METRICS_DIR: path.join(ROOT, "metrics"),
  // Health state snapshot persistence for sticky states.
  HEALTH_STATE_FILE: path.join(ROOT, "health-state.json"),
  // Prebuilt dashboard bundle.
  UI_DIST: path.join(ROOT, "dist"),

  // 4141 and 4142 are commonly taken by the historical deployment and vite dev
  // servers; the default stays out of their way. Configurable, never hardcoded.
  PORT: Number(process.env.CUPBEARER_PORT) || 4143,
  HOST: process.env.CUPBEARER_HOST || "127.0.0.1",
}
