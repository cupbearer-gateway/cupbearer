import React, { useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { stateMeta, reasonLabel, num, compact, pct, ms, ago } from "../format.js"
import { Card, Button, StatePill, Sparkline, Stat, Empty, Spinner, Banner, CopyBadge, Skeleton } from "./ui.jsx"
import {
  IconArrowLeft,
  IconChevronRight,
  IconWarning,
  IconIdle,
  IconHealthy,
  IconDead,
} from "./icons.jsx"

// ============================================================================
// Pool detail: the monitoring page. Every key on every leg, in priority order,
// with live state and the verbatim last error.
// ============================================================================

// Worst keys float to the top of each leg — you open this page when something
// is wrong, so the problem should be the first thing visible.
const RANK = { exhausted: 0, auth_failed: 0, dead: 0, degraded: 1, cooling: 2, healthy: 3 }

function KeyRow({ providerId, k, onChanged, testModel, index = 0 }) {
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const m = stateMeta(k.state)

  async function run(action) {
    setBusy(action)
    setResult(null)
    try {
      if (action === "test") {
        const r = await api.testKey(providerId, k.id, testModel)
        setResult(r.ok ? { ok: true, text: `OK in ${ms(r.latencyMs)}` } : { ok: false, text: r.message || r.reason })
      } else if (action === "clear") {
        await api.clearKey(providerId, k.id)
        setResult({ ok: true, text: "Returned to rotation" })
      }
      onChanged?.()
    } catch (e) {
      setResult({ ok: false, text: e.message })
    } finally {
      setBusy(null)
      setTimeout(() => setResult(null), 6000)
    }
  }

  return (
    <div
      className="grid grid-cols-12 items-center gap-3 px-3 py-3 text-[12px] transition-colors duration-200 hover:bg-[var(--color-raised)]/60"
      style={{ "--i": index }}
    >
      <div className="col-span-3 min-w-0">
        <div className="truncate font-medium text-[var(--color-ink)]">{k.label}</div>
        <div className="tnum mt-0.5 truncate text-[10.5px] text-[var(--color-ink-faint)]">{k.masked || "no value"}</div>
      </div>

      <div className="col-span-2">
        <StatePill state={k.state} meta={m} />
        {k.state === "cooling" && k.cooldownRemainingMs > 0 && (
          <div className="tnum mt-1 text-[10px] text-[var(--color-ink-faint)]">
            back in {Math.ceil(k.cooldownRemainingMs / 1000)}s
          </div>
        )}
        {k.modelStates?.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {k.modelStates.map((ms) => (
              <div
                key={ms.model}
                className="truncate text-[10px]"
                style={{ color: ms.state === "unavailable" ? "var(--color-warn)" : "var(--color-bad)" }}
                title={`${reasonLabel(ms.reason)} — ${ms.message}`}
              >
                {ms.model.split("/").pop()} · {reasonLabel(ms.reason)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tnum col-span-1 text-right text-[var(--color-ink-soft)]">{compact(k.calls)}</div>
      <div className="tnum col-span-1 text-right text-[var(--color-ink-soft)]">
        {k.calls ? pct(k.successRate) : "—"}
      </div>
      <div className="tnum col-span-1 text-right text-[var(--color-ink-soft)]">{ms(k.p50Ms)}</div>
      <div
        className="tnum col-span-1 text-right"
        style={{ color: k.p95Ms != null && k.p95Ms > 60000 ? "var(--color-warn)" : "var(--color-ink-soft)" }}
        title={k.p95Ms != null && k.p95Ms > 60000 ? "Close to the attempt timeout" : undefined}
      >
        {ms(k.p95Ms)}
      </div>
      <div className="tnum col-span-1 text-right text-[var(--color-ink-soft)]">
        {compact(k.tokensIn + k.tokensOut)}
      </div>

      <div className="col-span-2 flex items-center justify-end gap-1">
        {result && (
          <span
            className="mr-1 max-w-28 truncate text-[10.5px]"
            style={{ color: result.ok ? "var(--color-ok)" : "var(--color-bad)" }}
            title={result.text}
          >
            {result.text}
          </span>
        )}
        {k.sticky && (
          <Button size="sm" variant="ghost" onClick={() => run("clear")} disabled={busy} title="Return this key to rotation">
            {busy === "clear" ? <Spinner /> : "Reset"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => run("test")} disabled={busy || !k.present}>
          {busy === "test" ? <Spinner /> : "Test"}
        </Button>
      </div>

      {k.message && (
        <div className="col-span-12 -mt-0.5 flex items-start gap-2 pl-0 pt-1">
          <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">
            {reasonLabel(k.reason)} · {ago(k.lastErrorAt)}
          </span>
          <code className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-ink-faint)]" title={k.message}>
            {k.message}
          </code>
        </div>
      )}
    </div>
  )
}

function Leg({ leg, index, onChanged, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const keys = useMemo(
    () => leg.keys.slice().sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9)),
    [leg.keys],
  )

  const parked = !leg.providerEnabled
  const noKeys = leg.keys.length === 0
  const blocked = parked || noKeys || leg.usableKeyCount === 0

  return (
    <div className="border-b border-[var(--color-line)] last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-200 hover:bg-[var(--color-raised)]/50"
      >
        <span
          className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold"
          style={{
            background: blocked
              ? "color-mix(in oklab, var(--color-bad) 14%, transparent)"
              : "var(--color-overlay)",
            boxShadow: blocked
              ? "inset 0 0 0 1px color-mix(in oklab, var(--color-bad) 30%, transparent)"
              : "var(--shadow-hairline)",
            color: blocked ? "var(--color-bad)" : "var(--color-ink-soft)",
          }}
          title={`Priority ${index + 1}`}
        >
          {index + 1}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{leg.providerLabel}</span>
            {parked && (
              <span
                className="rounded-[4px] px-1.5 py-px text-[10px] font-medium"
                style={{
                  color: "var(--color-warn)",
                  background: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
                  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-warn) 30%, transparent)",
                }}
              >
                parked
              </span>
            )}
          </div>
          <div className="tnum mt-0.5 truncate text-[11px] text-[var(--color-ink-faint)]">{leg.model}</div>
        </div>

        <div className="shrink-0 text-right">
          <div className="tnum text-[13px] font-medium tracking-[-0.02em]">
            <span style={{ color: leg.usableKeyCount ? "var(--color-ok-soft)" : "var(--color-bad)" }}>
              {leg.usableKeyCount}
            </span>
            <span className="text-[var(--color-ink-faint)]">/{leg.keys.length}</span>
          </div>
          <div className="mt-0.5 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
            keys
          </div>
        </div>

        <span
          aria-hidden
          className="ml-1 flex shrink-0 text-[var(--color-ink-faint)] transition-transform duration-300 ease-[var(--ease-out-quint)]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <IconChevronRight size={12} />
        </span>
      </button>

      {open && (
        <div className="animate-slide-down bg-[var(--color-base)]/60">
          {noKeys ? (
            <div className="px-3 py-5 text-center text-[11.5px] text-[var(--color-ink-faint)]">
              No keys stored for this provider. Add one in Providers to bring this leg online.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-12 gap-3 border-y border-[var(--color-line)] px-3 py-2 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
                <div className="col-span-3">Key</div>
                <div className="col-span-2">State</div>
                <div className="col-span-1 text-right">Calls</div>
                <div className="col-span-1 text-right">OK</div>
                <div className="col-span-1 text-right">p50</div>
                <div className="col-span-1 text-right">p95</div>
                <div className="col-span-1 text-right">Tokens</div>
                <div className="col-span-2" />
              </div>
              <div className="stagger divide-y divide-[var(--color-line)]">
                {keys.map((k, i) => (
                  <KeyRow
                    key={k.id}
                    providerId={leg.providerId}
                    k={k}
                    index={i}
                    onChanged={onChanged}
                    testModel={leg.model}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function FeedRow({ row }) {
  const ok = row.ok
  const color = ok ? "var(--color-ok-soft)" : "var(--color-bad)"
  const Icon = ok ? IconHealthy : IconDead
  return (
    <div className="animate-fade flex items-center gap-2.5 px-3 py-2 text-[11px] transition-colors duration-200 hover:bg-[var(--color-raised)]/50">
      <span aria-hidden style={{ color }} className="flex shrink-0">
        <Icon size={11} />
      </span>
      <span className="tnum w-14 shrink-0 text-[var(--color-ink-faint)]">
        {new Date(row.at).toLocaleTimeString("en-GB", { hour12: false })}
      </span>
      <span className="w-24 shrink-0 truncate text-[var(--color-ink-soft)]">{row.providerId}</span>
      <span className="tnum w-14 shrink-0 text-right text-[var(--color-ink-faint)]">{ms(row.latencyMs)}</span>
      {row.attempts > 1 && (
        <span
          className="tnum shrink-0 rounded-[4px] px-1 py-px text-[10px]"
          style={{
            background: "color-mix(in oklab, var(--color-warn) 14%, transparent)",
            color: "var(--color-warn)",
          }}
          title={`${row.attempts} attempts — failed over`}
        >
          ×{row.attempts}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--color-ink-faint)]" title={row.message || ""}>
        {ok ? `${compact(row.tokensOut || 0)} out` : reasonLabel(row.reason)}
      </span>
    </div>
  )
}

export default function PoolDetail({ poolId, onBack, onEdit, onDeleted, refreshToken }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    try {
      setData(await api.poolDetail(poolId))
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    load()
  }, [poolId, refreshToken])

  useEffect(() => {
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [poolId])

  if (error) {
    return (
      <Card sheen>
        <Empty
          icon={IconWarning}
          title="Could not load this pool"
          body={error}
          action={<Button variant="outline" onClick={onBack}>Back</Button>}
        />
      </Card>
    )
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  async function removePool() {
    if (
      !window.confirm(
        `Delete pool "${pool.name}" (${pool.id})? It will stop working immediately for every client that calls it.`,
      )
    )
      return
    try {
      await api.deletePool(poolId)
      onDeleted?.(poolId)
    } catch (e) {
      setError(e.message)
    }
  }

  const { pool, series, feed } = data
  const s = pool.stats
  const h = pool.health
  const calls = series.map((b) => b.calls)
  const latency = series.map((b) => b.avgLatencyMs ?? 0)
  const failures = series.reduce((n, b) => n + b.failures, 0)

  return (
    <div className="space-y-3">
      <div className="animate-fade flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="group/back -ml-1.5 shrink-0">
          <span className="flex transition-transform duration-300 ease-[var(--ease-out-quint)] group-hover/back:-translate-x-0.5">
            <IconArrowLeft size={13} />
          </span>
          Pools
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="truncate text-[22px] font-semibold leading-tight">{pool.name}</h1>
            <CopyBadge value={pool.id} />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => onEdit(pool)} className="shrink-0">
          Edit pool
        </Button>
        <Button variant="danger" size="sm" onClick={removePool} className="shrink-0">
          Delete
        </Button>
      </div>

      {h.usableLegs === 0 && (
        <Banner tone="bad">
          Every leg in this pool is unusable right now, so requests to <code className="tnum">{pool.id}</code> will fail.
          Add a key or bring a provider back online.
        </Banner>
      )}

      <Card sheen className="animate-in">
        <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="24h calls" value={compact(s.calls)} sub={failures ? `${failures} failed` : "no failures"} />
          <Stat label="Success" value={s.calls ? pct(s.successRate, 1) : "—"} />
          <Stat label="p50" value={ms(s.p50Ms)} sub={s.p95Ms ? `p95 ${ms(s.p95Ms)}` : null} />
          <Stat
            label="Failover"
            value={s.failoverRate != null ? pct(s.failoverRate) : "—"}
            sub="calls needing a retry"
          />
          <Stat label="Tokens in" value={compact(s.tokensIn)} />
          <Stat label="Tokens out" value={compact(s.tokensOut)} />
        </div>
        <div className="grid grid-cols-1 gap-px border-t border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-2">
          <div className="bg-[var(--color-surface)] px-4 pb-3.5 pt-3">
            <div className="mb-1.5 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              Calls · last 60 min
            </div>
            <Sparkline values={calls} color="var(--color-accent)" />
          </div>
          <div className="bg-[var(--color-surface)] px-4 pb-3.5 pt-3">
            <div className="mb-1.5 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              Latency · last 60 min
            </div>
            <Sparkline values={latency} color="var(--color-cool)" />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <header className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Providers in priority order</h2>
            <span className="text-[11px] text-[var(--color-ink-faint)]">
              <span className="tnum text-[var(--color-ink-soft)]">{h.usableKeys}</span>
              <span className="tnum">/{h.totalKeys}</span> keys usable
            </span>
          </header>
          <div>
            {pool.legs.map((leg, i) => (
              <Leg
                key={`${leg.providerId}-${leg.model}-${i}`}
                leg={leg}
                index={i}
                defaultOpen={i === 0 || leg.usableKeyCount === 0}
                onChanged={load}
              />
            ))}
          </div>
        </Card>

        <Card>
          <header className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
            <h2 className="text-[13px] font-semibold">Live requests</h2>
            <span className="tnum text-[11px] text-[var(--color-ink-faint)]">{feed.length}</span>
          </header>
          {feed.length ? (
            <div className="max-h-[26rem] divide-y divide-[var(--color-line)] overflow-y-auto">
              {feed.map((row, i) => (
                <FeedRow key={`${row.at}-${i}`} row={row} />
              ))}
            </div>
          ) : (
            <Empty icon={IconIdle} title="No traffic yet" body="Calls to this pool will appear here as they happen." />
          )}
        </Card>
      </div>
    </div>
  )
}
