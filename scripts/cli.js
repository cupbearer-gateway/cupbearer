#!/usr/bin/env node
"use strict"
// Cupbearer CLI. `setup` (guided provider/key/pool wizard), `serve`, and
// `doctor` arrive in M5; this stub exists so the bin entry resolves from day one.

const args = process.argv.slice(2)
const command = args[0] || "help"

if (command === "serve" || command === "start") {
  require("../server/index.js")
  return
}

console.log("cupbearer — the LLM gateway that never hands your task to a model that can't handle it")
console.log("")
console.log("  cupbearer setup   guided provider + key + pool setup (coming in 0.2)")
console.log("  cupbearer serve   start the gateway (same as: node server/index.js)")
console.log("  cupbearer doctor  check config, keys, and upstream reachability (coming in 0.2)")
console.log("")
if (command !== "help" && command !== "setup" && command !== "doctor") {
  console.log(`unknown command: ${command}`)
  process.exitCode = 1
}
