import React, { useCallback, useEffect, useState } from "react"
import { api, subscribeEvents } from "../api.js"
import { ago, num, pct } from "../format.js"
import { Card, Empty, Select, Stat, Banner } from "./ui.jsx"
import { IconLayers } from "./icons.jsx"

// Quality view: the evidence board for quality-verified routing. Every gate
// decision the server made — shadow or enforced — with its score and what it
// did about it. Numbers come from the SQLite decision log; live "gate" events
// refresh the table without polling hard.

function DecisionRow({ d }) {
  const passed = d.passed
  const score = typeof d.score === "number" ? d.score.toFixed(2) : "—"
  const blocked = passed === false && d.mode === "gate"
  return (
    <tr className="border-b border-[var(--color-line)] align-top text-[12.5px] last:border-0">
      <td className="py-2 pr-3 text-[var(--color-ink-soft)]" title={new Date(d.ts).toISOString()}>
        {ago(d.ts)}
      </td>
      <td className="py-2 pr-3 tnum">{d.poolId}</td>
      <td className="py-2 pr-3">
        <span
          className="inline-flex items-center rounded-[5px] px-1.5 py-[3px] text-[10.5px] font-medium leading-none"
          style={{
            background: blocked ? "color-mix(in oklab, var(--color-bad) 14%, transparent)" : "color-mix(in oklab, var(--color-ok) 12%, transparent)",
            color: blocked ? "var(--color-bad)" : "var(--color-ok)",
          }}
        >
          {blocked ? "blocked & rerouted" : passed ? (d.mode === "gate" ? "gate passed" : "shadow ok") : "shadow fail"}
        </span>
      </td>
      <td className="py-2 pr-3 tnum">
        {d.providerId}/{d.model}
      </td>
      <td className="py-2 pr-3 tnum text-[var(--color-ink-soft)]">
        {d.downgrade ? `yes${d.requiredTier != null ? ` (need T${d.requiredTier})` : ""}` : "no"}
      </td>
      <td className="py-2 pr-3 tnum" title={`threshold ${d.threshold}`}>
        <span style={{ color: passed ? "var(--color-ink)" : "var(--color-bad)" }}>{score}</span>
      </td>
      <td className="py-2 text-[var(--color-ink-soft)]">{d.detail || (d.breakdown || []).filter((b) => b.score < 1).map((b) => `${b.id}: ${b.reason}`).join("; ") || "—"}</td>
    </tr>
  )
}

export default function Quality({ pools }) {
  const [pool, setPool] = useState("")
  const [decisions, setDecisions] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.qualityDecisions(150, pool || null), api.qualitySummary(24 * 3600 * 1000, pool || null)])
      setDecisions(d.decisions || [])
      setSummary(s.summary)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [pool])

  useEffect(() => {
    load()
    const t = setInterval(load, 8000)
    const unsub = subscribeEvents((type) => {
      if (type === "gate" || type === "success" || type === "failure") load()
    })
    return () => {
      clearInterval(t)
      unsub()
    }
  }, [load])

  const gated = summary?.gate ?? { decisions: 0, passed: 0 }
  const blocked = gated.decisions - gated.passed

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="brand-serif text-[15px] font-semibold">Every verdict, on the record</h2>
        <Select value={pool} onChange={(e) => setPool(e.target.value)} className="w-[180px] shrink-0" aria-label="Filter by pool">
          <option value="">all pools</option>
          {(pools || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </Select>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Decisions / 24h" value={num(summary.decisions)} sub={`${gated.decisions} gated · ${summary.shadow?.decisions ?? 0} shadow`} />
          <Stat label="Downgrades held" value={num(gated.passed)} sub={`of ${gated.decisions} gated attempts`} />
          <Stat label="Blocked & rerouted" value={num(blocked)} sub="quality below the bar — client never saw it" />
          <Stat label="Avg score" value={summary.avgScore != null ? summary.avgScore.toFixed(2) : "—"} sub="0–1 across all decisions" />
        </div>
      )}

      {summary && summary.decisions > 0 && blocked > 0 && (
        <Banner tone="ok">
          {blocked} downgrade attempt{blocked === 1 ? "" : "s"} failed the quality bar and {blocked === 1 ? "was" : "were"} stopped before
          the client saw a byte — stronger legs answered instead.
        </Banner>
      )}

      <Card>
        {error ? (
          <Empty icon={IconLayers} title="Could not load quality data" body={error} />
        ) : decisions === null ? (
          <div className="px-6 py-16 text-center text-[var(--color-ink-faint)]">loading…</div>
        ) : decisions.length === 0 ? (
          <Empty
            icon={IconLayers}
            title="No quality decisions yet"
            body={
              <>
                Decisions appear once the quality gate is active on a pool. Enable it with pool
                <span className="tnum"> qualityGate</span> mode <span className="tnum">"shadow"</span> (log only) or{" "}
                <span className="tnum">"gate"</span> (block failing downgrades).
              </>
            }
          />
        ) : (
          <div className="overflow-x-auto px-4 py-2">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Pool</th>
                  <th className="py-2 pr-3 font-medium">Outcome</th>
                  <th className="py-2 pr-3 font-medium">Leg</th>
                  <th className="py-2 pr-3 font-medium">Downgrade</th>
                  <th className="py-2 pr-3 font-medium">Score</th>
                  <th className="py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <DecisionRow key={d.id} d={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
