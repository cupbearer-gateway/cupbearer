import React, { useCallback, useEffect, useState } from "react"
import { api, subscribeEvents } from "../api.js"
import { ago, compact, ms } from "../format.js"
import { Card, Empty, Stat } from "./ui.jsx"
import Seal from "./Seal.jsx"
import { IconLayers } from "./icons.jsx"

// Stream — the default page and the product's soul. One live feed where every
// request tells its story: task tier → leg served → verdict seal → cost/latency.
// Hydrated from the SQLite-backed feed, then extended live via SSE.

const TIER_LABEL = { 1: "flagship", 2: "standard", 3: "light" }

// One row in the stream. `source` rows come from /api/feed (SQL-backed shape);
// live rows come from SSE events (slightly different shape) — normalise both.
function rowKey(r) {
  return `${r.at}-${r.providerId}-${r.model}`
}

function verdictOf(r) {
  if (r.ok) {
    if (typeof r.score === "number") return "held"
    return "served" // ungated: no seal, plain service
  }
  if (r.reason === "quality_gate_failed") return "blocked"
  return "failed"
}

function Row({ r, onClick, active }) {
  const verdict = verdictOf(r)
  const gated = verdict === "held" || verdict === "blocked"
  const seal = verdict === "held" ? "held" : verdict === "blocked" ? "blocked" : "shadow"
  return (
    <tr
      onClick={() => onClick(rowKey(r))}
      className={`cursor-pointer border-b border-[var(--color-line)] text-[12.5px] transition-colors last:border-0 hover:bg-[var(--color-raised)] ${
        active ? "bg-[var(--color-raised)]" : ""
      }`}
    >
      <td className="py-2.5 pl-4 pr-2 align-middle text-[var(--color-ink-faint)]" title={new Date(r.at).toISOString()}>
        {ago(r.at)}
      </td>
      <td className="py-2.5 pr-3 align-middle">
        {gated ? (
          <Seal verdict={seal} size={34} title={verdict} />
        ) : verdict === "failed" ? (
          <span className="tnum text-[11px] font-medium" style={{ color: "var(--color-bad)" }}>
            FAIL
          </span>
        ) : (
          <span className="tnum text-[11px] text-[var(--color-ink-faint)]">served</span>
        )}
      </td>
      <td className="py-2.5 pr-3 align-middle tnum">
        <span className="text-[var(--color-ink)]">{r.poolId}</span>
      </td>
      <td className="py-2.5 pr-3 align-middle tnum text-[var(--color-ink-soft)]">
        {r.providerId}/{r.model}
      </td>
      <td className="py-2.5 pr-3 align-middle text-[var(--color-ink-faint)]">
        {r.requiredTier ? (
          <span title={`request needed ${TIER_LABEL[r.requiredTier]}, leg is ${TIER_LABEL[r.servedTier] ?? "undeclared"}`}>
            {TIER_LABEL[r.requiredTier]}
            {r.downgrade || (r.requiredTier && r.servedTier && r.servedTier > r.requiredTier) ? (
              <span className="text-[var(--color-warn)]"> ↓tasted</span>
            ) : null}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="py-2.5 pr-3 align-middle tnum text-[var(--color-ink-soft)]">
        {typeof r.score === "number" ? (
          <span style={{ color: r.score >= 0.8 ? "var(--color-ok)" : "var(--color-bad)" }}>{r.score.toFixed(2)}</span>
        ) : (
          "—"
        )}
      </td>
      <td className="py-2.5 pr-3 align-middle tnum">{ms(r.latencyMs)}</td>
      <td className="py-2.5 pr-4 align-middle tnum text-[var(--color-ink-faint)]">
        {compact(r.tokensIn || 0)}→{compact(r.tokensOut || 0)}
      </td>
    </tr>
  )
}

function TastingCard({ r }) {
  const verdict = verdictOf(r)
  const lines = []
  if (verdict === "held") {
    lines.push(`Served from ${r.providerId}/${r.model} after the quality check passed (score ${r.score?.toFixed(2)}).`)
    if (r.servedTier && r.requiredTier && r.servedTier > r.requiredTier) {
      lines.push("This was a downgrade — a stronger leg was not needed, or had already failed.")
    }
  } else if (verdict === "blocked") {
    lines.push(`A response from ${r.providerId}/${r.model} scored ${r.score?.toFixed(2)} — below the bar. The client never saw it; a stronger leg answered instead.`)
    lines.push(`Gate reason: ${r.message || "quality below threshold"}.`)
  } else if (verdict === "failed") {
    lines.push(`${r.providerId}/${r.model} failed: ${r.reason || "error"}${r.message ? ` — ${r.message}` : ""}.`)
  } else {
    lines.push(`Served from ${r.providerId}/${r.model} — no gate active on this pool, so no tasting happened.`)
  }
  return (
    <tr className="bg-[var(--color-overlay)]">
      <td colSpan={8} className="px-4 py-3 text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
        <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">The tasting</div>
        {lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
      </td>
    </tr>
  )
}

export default function Stream() {
  const [rows, setRows] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const [activeKey, setActiveKey] = useState(null)

  const hydrate = useCallback(async () => {
    try {
      const [feed, q] = await Promise.all([api.feed(80), api.qualitySummary(24 * 3600 * 1000).catch(() => ({}))])
      setRows(feed.feed || [])
      setSummary(q.summary || null)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    hydrate()
    const t = setInterval(hydrate, 20000)
    const unsub = subscribeEvents((type, data) => {
      if (type === "success" || type === "failure" || type === "gate") {
        // Live events arrive pre-flush; the next 20s hydrate replaces them with
        // the SQL rows. Prepend what we know now so the stream feels instant.
        setRows((prev) => {
          if (!prev) return prev
          const row =
            type === "gate"
              ? { at: Date.now(), poolId: data.poolId, providerId: data.providerId, model: data.model, ok: Boolean(data.passed), reason: data.passed ? null : "quality_gate_failed", score: data.score, latencyMs: null, tokensIn: 0, tokensOut: 0, live: true }
              : { at: Date.now(), poolId: data.poolId, providerId: data.providerId, model: data.model, ok: type === "success", reason: data.reason, message: data.message, score: data.score ?? null, requiredTier: data.requiredTier ?? null, servedTier: data.servedTier ?? null, latencyMs: data.latencyMs ?? null, tokensIn: 0, tokensOut: data.tokensOut ?? 0, live: true }
          return [row, ...prev.filter((p) => !p.live).slice(0, 79)]
        })
      }
    })
    return () => {
      clearInterval(t)
      unsub()
    }
  }, [hydrate])

  const gatedRows = (rows || []).filter((r) => typeof r.score === "number")
  const blocked = (rows || []).filter((r) => r.reason === "quality_gate_failed").length

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Stream (recent)" value={rows ? compact(rows.length) : "…"} sub="latest requests" />
        <Stat label="Tasted / 24h" value={summary ? compact(summary.decisions) : "…"} sub="gate decisions logged" />
        <Stat label="Blocked & rerouted" value={summary ? compact(summary.gate ? summary.gate.decisions - summary.gate.passed : 0) : "…"} sub="client never saw them" />
        <Stat label="Avg score" value={summary?.avgScore != null ? summary.avgScore.toFixed(2) : "—"} sub="0–1 across decisions" />
      </div>

      {blocked > 0 && (
        <div className="rounded-[var(--radius-card)] px-4 py-3 text-[12.5px]" style={{ background: "var(--color-accent-tint)", color: "var(--color-accent-soft)" }}>
          {blocked} downgrade{blocked === 1 ? "" : "s"} in this window failed the tasting and were rerouted — the client held better answers because of it.
        </div>
      )}

      <Card sheen>
        {error ? (
          <Empty icon={IconLayers} title="Could not load the stream" body={error} />
        ) : rows === null ? (
          <div className="px-6 py-16 text-center text-[var(--color-ink-faint)]">pouring…</div>
        ) : rows.length === 0 ? (
          <Empty
            icon={IconLayers}
            title="No traffic yet"
            body={
              <>
                Point any client at <span className="tnum">http://127.0.0.1:4143/v1</span> (model = one of your pool ids) and the
                stream starts here — every request, every verdict, sealed.
              </>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                  <th className="py-2 pl-4 pr-2 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Verdict</th>
                  <th className="py-2 pr-3 font-medium">Pool</th>
                  <th className="py-2 pr-3 font-medium">Leg</th>
                  <th className="py-2 pr-3 font-medium">Task</th>
                  <th className="py-2 pr-3 font-medium">Score</th>
                  <th className="py-2 pr-3 font-medium">Latency</th>
                  <th className="py-2 pr-4 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 40).map((r) => {
                  const key = rowKey(r)
                  return (
                    <React.Fragment key={key + (r.live ? "-live" : "")}>
                      <Row r={r} active={activeKey === key} onClick={setActiveKey} />
                      {activeKey === key && <TastingCard r={r} />}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {rows && rows.length > 40 && (
        <p className="text-[11px] text-[var(--color-ink-faint)]">showing the 40 most recent — the full history lives in the evidence log</p>
      )}
    </div>
  )
}
