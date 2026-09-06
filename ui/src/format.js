// Formatting + shared vocabulary. Keeping this in one place is what makes
// numbers read consistently across every screen.

export const STATE_META = {
  healthy: { label: "Healthy", color: "var(--color-ok)", tone: "ok", glyph: "●" },
  degraded: { label: "Degraded", color: "var(--color-warn)", tone: "warn", glyph: "▲" },
  cooling: { label: "Cooling", color: "var(--color-cool)", tone: "cool", glyph: "◐" },
  exhausted: { label: "Out of quota", color: "var(--color-bad)", tone: "bad", glyph: "✕" },
  auth_failed: { label: "Key rejected", color: "var(--color-bad)", tone: "bad", glyph: "✕" },
  dead: { label: "Dead", color: "var(--color-bad)", tone: "bad", glyph: "✕" },
}

export function stateMeta(state) {
  return STATE_META[state] || { label: state || "Unknown", color: "var(--color-idle)", tone: "idle", glyph: "○" }
}

// Machine reason tokens, in plain English.
export const REASON_LABEL = {
  budget_exhausted: "Upstream quota cap reached (admin-side, not per-key)",
  credit_exhausted: "Key has no quota left",
  payment_required: "Upstream requires payment",
  invalid_key: "Key rejected by upstream",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  group_disabled: "Account group disabled",
  client_rejected: "Upstream rejected our client — needs the waf-headers quirk",
  concurrency_limit: "Too many requests at once",
  rate_limited: "Rate limited",
  provider_busy: "Provider busy — request queue full",
  no_channel: "No capacity for this model here",
  model_unavailable: "Model not available here",
  model_retired: "Model retired upstream (end of life)",
  model_gated: "Model restricted by the provider",
  truncated_tool_call: "Tool call truncated by an output cap",
  context_too_long: "Prompt exceeded the context window",
  content_filtered: "Blocked by a content filter",
  upstream_timeout: "Upstream timed out",
  upstream_error: "Upstream server error",
  connection_failed: "Could not connect",
  timeout: "Timed out",
  stream_failed: "Stream failed mid-response",
  first_byte_timeout: "Accepted the request, then sent nothing",
  request_budget_exceeded: "No provider answered inside the request budget",
  bad_request: "Malformed request",
  not_found: "Not found",
  unknown: "Unknown error",
}

export const SKIP_LABEL = {
  provider_disabled: "provider parked",
  provider_missing: "provider deleted",
  no_keys: "no keys stored",
  all_keys_unusable: "all keys unusable",
  bad_quirks: "quirk misconfigured",
}

export function reasonLabel(reason) {
  return REASON_LABEL[reason] || reason || "—"
}

export function num(n) {
  if (n === null || n === undefined) return "—"
  return new Intl.NumberFormat("en-US").format(n)
}

export function compact(n) {
  if (n === null || n === undefined) return "—"
  if (n < 1000) return String(n)
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

export function pct(v, digits = 0) {
  if (v === null || v === undefined) return "—"
  return `${(v * 100).toFixed(digits)}%`
}

export function ms(v) {
  if (v === null || v === undefined) return "—"
  if (v < 1000) return `${Math.round(v)}ms`
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`
}

export function ago(timestamp) {
  if (!timestamp) return "never"
  const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export function poolModality(pool) {
  if (!pool) return "text"
  const id = (pool.id || "").toLowerCase()
  const name = (pool.name || "").toLowerCase()
  if (id === "vision" || id.includes("vision") || name.includes("vision")) return "vision"
  if (id === "audio" || id.includes("audio") || name.includes("audio") || id.includes("whisper")) return "audio"
  const hasVisionLeg = pool.legs?.some((l) => (l.model || "").toLowerCase().includes("vision") || (l.model || "").toLowerCase().includes("-vl"))
  if (hasVisionLeg) return "vision"
  const hasAudioLeg = pool.legs?.some((l) => (l.model || "").toLowerCase().includes("whisper") || (l.model || "").toLowerCase().includes("audio"))
  if (hasAudioLeg) return "audio"
  return "text"
}
