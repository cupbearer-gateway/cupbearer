"use strict"

// Idempotent helper: stamps a `// DOC:` pointer into each server module's header
// so any agent (or human) landing on a file can jump straight to the relevant
// section of docs/. Re-run after adding a new module — add its entry to POINTERS.
//
// Usage: node scripts/doc-pointer.js

const fs = require("fs")
const path = require("path")

const POINTERS = {
  "server/index.js": "../docs/operations.md → § Running · ../docs/architecture.md → § Module map → server/index.js",
  "server/paths.js": "../docs/architecture.md → § Module map → server/paths.js",
  "server/config.js": "../docs/architecture.md → § Module map → server/config.js · ../docs/operations.md → § Backup / restore",
  "server/secrets.js": "../docs/architecture.md → § Module map → server/secrets.js",
  "server/classify.js": "../docs/architecture.md → § Module map → server/classify.js",
  "server/health.js": "../docs/architecture.md → § Module map → server/health.js · ../docs/operations.md → § Auto-revival & background probes",
  "server/metrics.js": "../docs/architecture.md → § Module map → server/metrics.js",
  "server/events.js": "../docs/architecture.md → § Module map → server/events.js · ../docs/api.md → § SSE events (GET /api/events)",
  "server/upstream.js": "../docs/architecture.md → § Module map → server/upstream.js",
  "server/relay.js": "../docs/architecture.md → § The deferred-commit failover contract · ../docs/quirks.md → § The stream translator contract",
  "server/router.js": "../docs/architecture.md → § Module map → server/router.js · § Request lifecycle",
  "server/profile.js": "../docs/architecture.md → § Module map → server/profile.js",
  "server/openai-surface.js": "../docs/api.md → § OpenAI surface",
  "server/anthropic-surface.js": "../docs/api.md → § Anthropic-compatible surface",
  "server/api.js": "../docs/api.md → § Dashboard API · § SSE events (GET /api/events)",
  "server/notify.js": "../docs/operations.md → § Desktop notifications · ../docs/architecture.md → § Module map → server/notify.js",
  "server/revive.js": "../docs/operations.md → § Auto-revival & background probes · ../docs/architecture.md → § Module map → server/notify.js",
  "server/canary.js": "../docs/operations.md → § Auto-revival & background probes · ../docs/architecture.md → § Module map → server/notify.js",
  "server/store.js": "../docs/architecture.md → § Module map → server/store.js · § Storage",
  "server/presets.js": "../docs/architecture.md → § Module map → server/presets.js",
  "server/http-util.js": "../docs/api.md → § Dashboard API",
  "server/quality/gate.js": "../../docs/architecture.md → § Module map → server/quality/ · ../../docs/operations.md → § Quality gate in practice",
  "server/quality/evaluators.js": "../../docs/architecture.md → § Module map → server/quality/",
  "server/quality/judge.js": "../../docs/architecture.md → § Module map → server/quality/",
  "server/quirks/index.js": "../../docs/quirks.md → § The quirk interface · § Gotchas",
  "server/quirks/qwen-xml.js": "../../docs/quirks.md → § qwen-xml",
  "server/quirks/think-tags.js": "../../docs/quirks.md → § think-tags",
  "server/quirks/deepseek-tools.js": "../../docs/quirks.md → § deepseek-tools",
  "server/quirks/waf-headers.js": "../../docs/quirks.md → § waf-headers",
  "server/quirks/sse-null.js": "../../docs/quirks.md → § sse-null",
  "server/quirks/nvidia-nim.js": "../../docs/quirks.md → § nvidia-nim",
  "server/quirks/openrouter.js": "../../docs/quirks.md → § openrouter",
  "server/quirks/aistudio-schema.js": "../../docs/quirks.md → § aistudio-schema",
  "server/quirks/aistudio-think-sig.js": "../../docs/quirks.md → § aistudio-think-sig",
  "server/quirks/aistudio-multipart.js": "../../docs/quirks.md → § aistudio-multipart",
}

const root = path.join(__dirname, "..")

for (const [rel, doc] of Object.entries(POINTERS)) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    console.error(`missing: ${rel}`)
    continue
  }
  let text = fs.readFileSync(file, "utf8")
  const line = `// DOC: ${doc}`

  if (text.includes("// DOC:")) {
    const updated = text.replace(/^\/\/ DOC:.*$/m, line)
    if (updated !== text) {
      fs.writeFileSync(file, updated)
      console.log(`updated ${rel}`)
    } else {
      console.log(`unchanged ${rel}`)
    }
  } else {
    // Insert after the "use strict" line so the pointer is the first comment.
    const lines = text.split("\n")
    const idx = lines.findIndex((l) => l.trim() === '"use strict"')
    if (idx === -1) {
      console.error(`no use strict in ${rel}`)
      continue
    }
    lines.splice(idx + 1, 0, line)
    fs.writeFileSync(file, lines.join("\n"))
    console.log(`stamped ${rel}`)
  }
}

console.log("done")
