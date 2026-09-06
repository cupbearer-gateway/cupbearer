import React, { useState, useMemo } from "react"
import { stateMeta, num, compact, pct, ms, poolModality } from "../format.js"
import { Card, HealthStrip, CopyBadge, Empty, Button } from "./ui.jsx"
import { IconPlus, IconPool, IconWarning, IconChevronRight, IconText, IconVision, IconAudio } from "./icons.jsx"

// Health strip segments, worst-first so trouble is visible at the left edge
const RANK = { exhausted: 0, auth_failed: 0, dead: 0, degraded: 1, cooling: 2, healthy: 3 }

const MODALITY_META = {
  text: {
    label: "Text",
    icon: IconText,
    color: "var(--color-ink-soft)",
    bg: "var(--color-overlay)",
    border: "var(--color-line)",
  },
  vision: {
    label: "Vision",
    icon: IconVision,
    color: "var(--color-ok-soft)",
    bg: "color-mix(in oklab, var(--color-ok) 12%, transparent)",
    border: "color-mix(in oklab, var(--color-ok) 30%, transparent)",
  },
  audio: {
    label: "Audio",
    icon: IconAudio,
    color: "var(--color-warn)",
    bg: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
    border: "color-mix(in oklab, var(--color-warn) 30%, transparent)",
  },
}

function modalityChip(pool) {
  const mod = poolModality(pool)
  const meta = MODALITY_META[mod] || MODALITY_META.text
  const Icon = meta.icon
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider"
      style={{
        color: meta.color,
        background: meta.bg,
        boxShadow: `inset 0 0 0 1px ${meta.border}`,
      }}
      title={`Modality: ${meta.label}`}
    >
      <Icon size={10} />
      {meta.label}
    </span>
  )
}

const STRATEGY_LABEL = {
  "round-robin": "manual order",
  "fastest-first": "fastest first",
  quality: "quality first",
  "sticky-until-error": "sticky key",
}

function strategyChip(pool) {
  const label = STRATEGY_LABEL[pool.keyStrategy] || pool.keyStrategy || "manual order"
  return (
    <span
      className="tnum inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px text-[10px] font-medium"
      style={{
        color: "var(--color-ink-soft)",
        background: "var(--color-overlay)",
        boxShadow: "inset 0 0 0 1px var(--color-line)",
      }}
      title="How keys/providers are chosen in this pool"
    >
      {label}
    </span>
  )
}

function segmentsFor(pool) {
  const keys = pool.legs.flatMap((l) => (l.providerEnabled ? l.keys : []))
  return keys
    .slice()
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9))
    .map((k) => {
      const m = stateMeta(k.state)
      return { color: m.color, title: `${k.label}: ${m.label}` }
    })
}

function PoolCard({ pool, onOpen, onAddLeg, index }) {
  const s = pool.stats
  const h = pool.health
  const segments = segmentsFor(pool)

  const broken = h.usableLegs === 0
  const thin = !broken && h.usableLegs === 1 && h.totalLegs > 1
  const churn = s.calls ? s.failoverRate : null
  const churnHot = churn !== null && churn > 0.25
  const edge = broken ? "var(--color-bad)" : thin ? "var(--color-warn)" : null

  return (
    <div
      className="card-interactive hover:card-interactive-hover group relative flex flex-col justify-between overflow-hidden"
      style={{ "--i": index }}
    >
      {edge ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
          style={{ background: edge }}
        />
      ) : (
        <div aria-hidden className="panel-sheen-top pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      )}

      <div
        className="cursor-pointer p-4"
        onClick={() => onOpen(pool.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen(pool.id)
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 truncate text-[15px] font-semibold">
              {pool.name}
              <span
                aria-hidden
                className="flex -translate-x-1 text-[var(--color-ink-faint)] opacity-0 transition-all duration-300 ease-[var(--ease-out-quint)] group-hover:translate-x-0 group-hover:text-[var(--color-accent-soft)] group-hover:opacity-100"
              >
                <IconChevronRight size={13} />
              </span>
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {modalityChip(pool)}
              <CopyBadge value={pool.id} />
              {strategyChip(pool)}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="tnum text-[15px] font-medium leading-none tracking-[-0.02em]">
              {h.usableLegs}
              <span className="text-[var(--color-ink-faint)]">/{h.totalLegs}</span>
            </div>
            <div className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              legs
            </div>
          </div>
        </div>

        <div className="mt-4">
          <HealthStrip segments={segments} />
          <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--color-ink-faint)]">
            <span>
              <span className="tnum text-[var(--color-ink-soft)]">{h.usableKeys}</span> of{" "}
              <span className="tnum">{h.totalKeys}</span> keys usable
            </span>
            {churn !== null && churn > 0 && (
              <span
                className="tnum"
                style={{ color: churnHot ? "var(--color-warn)" : "var(--color-ink-soft)" }}
                title="Share of requests that needed more than one attempt"
              >
                {pct(churn)} failed over
              </span>
            )}
          </div>
        </div>

        {(broken || thin) && (
          <div
            className="mt-3.5 flex items-start gap-2 rounded-[6px] px-2 py-1.5 text-[11px] leading-snug"
            style={{
              background: `color-mix(in oklab, ${broken ? "var(--color-bad)" : "var(--color-warn)"} 12%, transparent)`,
              color: broken ? "var(--color-bad)" : "var(--color-warn)",
            }}
          >
            <span className="mt-px flex shrink-0">
              <IconWarning size={12} />
            </span>
            {broken ? "No usable provider — this pool will fail" : "Only one usable leg — no fallback left"}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-base)]/50 px-3 py-2 text-[11px]">
        <div className="flex items-center gap-3">
          <div>
            <span className="text-[9.5px] uppercase text-[var(--color-ink-faint)]">24h calls: </span>
            <span className="tnum font-medium text-[var(--color-ink-soft)]">{compact(s.calls)}</span>
          </div>
          <div>
            <span className="text-[9.5px] uppercase text-[var(--color-ink-faint)]">p50: </span>
            <span className="tnum font-medium text-[var(--color-ink-soft)]">{ms(s.p50Ms)}</span>
          </div>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onAddLeg(pool)
          }}
          className="flex items-center gap-1 rounded-[5px] bg-[var(--color-overlay)] px-2 py-1 text-[11px] font-medium text-[var(--color-accent-soft)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-white"
          title="Add a provider or leg directly to this pool"
        >
          <IconPlus size={11} />
          <span>Add Provider</span>
        </button>
      </div>
    </div>
  )
}

export default function PoolsGrid({ pools, onOpen, onCreate, onEdit }) {
  const [activeModality, setActiveModality] = useState("all")

  // Group & filter pools by modality
  const poolsByModality = useMemo(() => {
    const counts = { all: pools.length, text: 0, vision: 0, audio: 0 }
    const filtered = []

    for (const p of pools) {
      const mod = poolModality(p)
      if (counts[mod] !== undefined) counts[mod]++
      if (activeModality === "all" || mod === activeModality) {
        filtered.push(p)
      }
    }

    return { counts, filtered }
  }, [pools, activeModality])

  if (!pools.length) {
    return (
      <Card sheen>
        <Empty
          icon={IconPool}
          title="No pools yet"
          body="A pool is one model name that fans out across several providers. Create one and any client can call it directly."
          action={
            <Button variant="primary" onClick={onCreate}>
              Create a pool
            </Button>
          }
        />
      </Card>
    )
  }

  const { counts, filtered } = poolsByModality

  return (
    <div className="space-y-4">
      {/* Modality Filter Bar */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-3">
        <div className="flex items-center gap-1.5 rounded-[var(--radius-inner)] bg-[var(--color-base)] p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
          {[
            { id: "all", label: "All Modalities", icon: IconPool },
            { id: "text", label: "Text", icon: IconText },
            { id: "vision", label: "Vision", icon: IconVision },
            { id: "audio", label: "Audio", icon: IconAudio },
          ].map((tab) => {
            const active = activeModality === tab.id
            const Icon = tab.icon
            const count = counts[tab.id] || 0

            return (
              <button
                key={tab.id}
                onClick={() => setActiveModality(tab.id)}
                className={`flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-all ${
                  active
                    ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-hairline)]"
                    : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]"
                }`}
              >
                <Icon size={12} style={{ color: active ? "var(--color-accent-soft)" : "inherit" }} />
                <span>{tab.label}</span>
                <span
                  className="tnum rounded-[4px] px-1 py-px text-[10px]"
                  style={{
                    background: active ? "var(--color-overlay)" : "transparent",
                    color: active ? "var(--color-ink-soft)" : "var(--color-ink-faint)",
                  }}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <Button variant="primary" size="sm" onClick={onCreate}>
          <IconPlus size={12} />
          Create Pool
        </Button>
      </div>

      {/* Grid of Pools */}
      {filtered.length === 0 ? (
        <Card sheen>
          <Empty
            icon={IconPool}
            title={`No ${activeModality} pools found`}
            body={`You don't have any pools matching the "${activeModality}" modality.`}
            action={
              <Button variant="outline" onClick={() => setActiveModality("all")}>
                View all pools
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p, i) => (
            <PoolCard key={p.id} pool={p} onOpen={onOpen} onAddLeg={onEdit} index={i} />
          ))}

          <button
            onClick={onCreate}
            style={{ "--i": filtered.length }}
            className="group flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-[var(--radius-card)] text-[var(--color-ink-faint)] shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[box-shadow,background-color,color] duration-300 ease-[var(--ease-smooth)] hover:bg-[var(--color-surface)] hover:text-[var(--color-accent-soft)] hover:shadow-[inset_0_0_0_1px_var(--color-accent-dim)]"
          >
            <span
              aria-hidden
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-raised)] shadow-[var(--shadow-hairline)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-110 group-hover:rotate-90"
            >
              <IconPlus size={16} />
            </span>
            <span className="text-xs font-medium">New pool</span>
          </button>
        </div>
      )}
    </div>
  )
}
