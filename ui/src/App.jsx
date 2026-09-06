import React, { useCallback, useEffect, useRef, useState } from "react"
import { api, subscribeEvents } from "./api.js"
import { compact, pct, ms } from "./format.js"
import { Button, Banner, Skeleton, Empty, Card } from "./components/ui.jsx"
import { Logo, IconWarning, IconPool, IconServer, IconSliders, IconRail, IconLayers } from "./components/icons.jsx"
import PoolsGrid from "./components/PoolsGrid.jsx"
import PoolDetail from "./components/PoolDetail.jsx"
import PoolBuilder from "./components/PoolBuilder.jsx"
import Providers from "./components/Providers.jsx"
import Operations from "./components/Operations.jsx"
import Quality from "./components/Quality.jsx"

// ============================================================================
// Shell: collapsible side nav, a calm top bar per view, and routing between the
// views. Data comes from /api/overview; SSE nudges a refetch so the UI
// tracks real traffic without polling hard.
// ============================================================================

const VIEWS = [
  { name: "pools", label: "Pools", icon: IconPool },
  { name: "providers", label: "Providers", icon: IconServer },
  { name: "quality", label: "Quality", icon: IconLayers },
  { name: "operations", label: "Operations", icon: IconSliders },
]

function LiveDot({ connected, pulse }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[6px] text-[10.5px] font-medium tracking-wide"
      style={{ color: connected ? "var(--color-ok-soft)" : "var(--color-idle)" }}
      title={connected ? "Receiving live events" : "Not connected"}
    >
      <span aria-hidden className={`flex h-[6px] w-[6px] rounded-full ${pulse ? "animate-ping-once" : ""}`}>
        <span
          className={`h-full w-full rounded-full ${connected ? "animate-breathe" : ""}`}
          style={{
            background: "currentColor",
            boxShadow: connected ? "0 0 8px 0 currentColor" : "none",
          }}
        />
      </span>
      {connected ? "live" : "offline"}
    </span>
  )
}

function NavItem({ active, icon: Icon, label, count, collapsed, onClick }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`group/nav relative flex w-full items-center gap-2.5 rounded-[var(--radius-inner)] px-2 py-1.5 text-[12.5px] font-medium transition-colors duration-200 ${
        collapsed ? "justify-center px-0" : ""
      } ${active ? "" : "hover:bg-[var(--color-raised)]"}`}
      style={{ color: active ? "var(--color-ink)" : "var(--color-ink-faint)" }}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-[var(--radius-inner)]"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 13%, transparent)",
            boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-accent) 30%, transparent)",
          }}
        />
      )}
      <span
        className="relative flex shrink-0"
        style={{ color: active ? "var(--color-accent-soft)" : "inherit" }}
      >
        <Icon size={14} />
      </span>
      {!collapsed && (
        <>
          <span className="relative min-w-0 flex-1 truncate text-left">{label}</span>
          {count !== undefined && (
            <span className="tnum relative rounded-[4px] px-1 py-px text-[10px] leading-tight text-[var(--color-ink-soft)]">
              {count}
            </span>
          )}
        </>
      )}
    </button>
  )
}

export default function App() {
  const [view, setView] = useState({ name: "pools" })
  const [collapsed, setCollapsed] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [connected, setConnected] = useState(false)
  const [pulse, setPulse] = useState(false)
  const [builder, setBuilder] = useState({ open: false, editing: null })
  const [detailToken, setDetailToken] = useState(0)

  const refetchTimer = useRef(null)

  const load = useCallback(async () => {
    try {
      const next = await api.overview()
      setData(next)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Coalesce SSE bursts: a busy pool fires many events per second, and
  // refetching per event would thrash. One refetch per 700ms is plenty.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null
      load()
      setDetailToken((t) => t + 1)
    }, 700)
  }, [load])

  useEffect(() => {
    const unsubscribe = subscribeEvents((type) => {
      setConnected(true)
      if (type === "success" || type === "failure") {
        setPulse(true)
        setTimeout(() => setPulse(false), 1000)
      }
      scheduleRefetch()
    })
    // EventSource opening is enough to call ourselves connected.
    const t = setTimeout(() => setConnected(true), 800)
    return () => {
      clearTimeout(t)
      unsubscribe()
    }
  }, [scheduleRefetch])

  // Slow safety-net poll for cooldown countdowns and anything an SSE drop missed.
  useEffect(() => {
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  if (error && !data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <Card sheen>
          <Empty
            icon={IconWarning}
            title="Cannot reach the Cupbearer server"
            body={error}
            action={
              <Button variant="primary" onClick={load}>
                Retry
              </Button>
            }
          />
        </Card>
      </div>
    )
  }

  const pools = data?.pools ?? []
  const providers = data?.providers ?? []
  const quirks = data?.quirks ?? []
  const stats = data?.stats
  const settings = data?.settings

  const brokenPools = pools.filter((p) => p.health.usableLegs === 0)
  const deadKeys = providers.flatMap((p) =>
    p.keys.filter((k) => k.sticky).map((k) => ({ provider: p, key: k })),
  )

  const showTopBar = view.name !== "pool"
  const activeView = VIEWS.find((v) => v.name === view.name) || VIEWS[0]

  return (
    <div className="flex min-h-full">
      {/* ================================================== side nav ========= */}
      <aside
        className={`sticky top-0 z-30 flex h-screen shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-base)]/95 backdrop-blur-2xl transition-[width] duration-200 ease-[var(--ease-smooth)] ${
          collapsed ? "w-[52px]" : "w-[188px]"
        }`}
      >
        {/* Logo + collapse toggle */}
        <div className={`flex items-center border-b border-[var(--color-line)] ${collapsed ? "justify-center" : "justify-between"} px-2 py-3`}>
          {!collapsed && (
            <button
              onClick={() => setView({ name: "pools" })}
              className="flex items-center gap-2 transition-transform duration-300 ease-[var(--ease-spring)] hover:scale-[1.03]"
              aria-label="Cupbearer home"
            >
              <Logo />
              <span className="text-[14px] font-semibold tracking-[-0.01em]">Cupbearer</span>
            </button>
          )}
          {collapsed && (
            <button onClick={() => setView({ name: "pools" })} aria-label="Cupbearer home" className="flex justify-center">
              <Logo size={22} />
            </button>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-ink-faint)] transition-colors duration-200 hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label="Toggle sidebar"
          >
            <IconRail size={13} style={collapsed ? { transform: "rotate(180deg)" } : undefined} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-0.5 px-2 py-3" aria-label="Main">
          {VIEWS.map((v) => (
            <NavItem
              key={v.name}
              active={v.name === "pools" ? view.name === "pools" || view.name === "pool" : view.name === v.name}
              icon={v.icon}
              label={v.label}
              count={v.name === "pools" ? pools.length : v.name === "providers" ? providers.length : undefined}
              collapsed={collapsed}
              onClick={() => setView({ name: v.name })}
            />
          ))}
        </nav>

        <div className="flex-1" />

        {/* Footer: live + today's summary */}
        <div className={`space-y-2.5 border-t border-[var(--color-line)] ${collapsed ? "px-0 py-3" : "px-3 py-3"}`}>
          {!collapsed && stats && (
            <div className="space-y-1">
              <div className="tnum text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                <span className="text-[var(--color-ink)]">{compact(stats.calls)}</span> calls / 24h
              </div>
              <div className="tnum text-[11px] text-[var(--color-ink-faint)]">
                {stats.calls ? pct(stats.successRate) : "—"} success · p50{" "}
                <span className="text-[var(--color-ink-soft)]">{ms(stats.p50Ms)}</span>
              </div>
            </div>
          )}
          <div className={collapsed ? "flex justify-center" : ""}>
            <LiveDot connected={connected} pulse={pulse} />
          </div>
          {!collapsed && (
            <div className="text-[9.5px] leading-relaxed text-[var(--color-ink-faint)]">
              <span className="tnum text-[var(--color-ink-soft)]">127.0.0.1:4143</span>
              <br />
              loopback only · holds your keys
            </div>
          )}
        </div>
      </aside>

      {/* =============================================== content column ====== */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim top bar per view */}
        {showTopBar && (
          <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-base)]/78 px-4 backdrop-blur-2xl sm:px-6">
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{activeView.label}</h1>
            </div>
            <div className="flex-1" />
          </header>
        )}

        <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-3 px-4 py-5 sm:px-6">
          {brokenPools.length > 0 && view.name !== "pool" && (
            <Banner tone="bad">
              {brokenPools.length === 1 ? (
                <>
                  Pool <span className="tnum">{brokenPools[0].id}</span> has no usable provider and will fail.
                </>
              ) : (
                <>
                  {brokenPools.length} pools have no usable provider:{" "}
                  <span className="tnum">{brokenPools.map((p) => p.id).join(", ")}</span>
                </>
              )}
            </Banner>
          )}

          {!data ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-[168px]" />
              <Skeleton className="h-[168px]" />
              <Skeleton className="h-[168px]" />
            </div>
          ) : view.name === "pools" ? (
            <>
              {deadKeys.length > 0 && (
                <Banner
                  tone="warn"
                  action={
                    <Button size="sm" variant="outline" onClick={() => setView({ name: "providers" })}>
                      Manage keys
                    </Button>
                  }
                >
                  {deadKeys.length} key{deadKeys.length > 1 ? "s" : ""} out of rotation:{" "}
                  {deadKeys
                    .slice(0, 3)
                    .map(({ provider, key }) => `${provider.label} · ${key.label}`)
                    .join(", ")}
                  {deadKeys.length > 3 && ` +${deadKeys.length - 3} more`}
                </Banner>
              )}
              <PoolsGrid
                pools={pools}
                onOpen={(id) => setView({ name: "pool", id })}
                onCreate={() => setBuilder({ open: true, editing: null })}
                onEdit={(pool) => setBuilder({ open: true, editing: pool })}
              />
            </>
          ) : view.name === "pool" ? (
            <PoolDetail
              poolId={view.id}
              refreshToken={detailToken}
              onBack={() => setView({ name: "pools" })}
              onEdit={(pool) => setBuilder({ open: true, editing: pool })}
              onDeleted={() => {
                setView({ name: "pools" })
                load()
              }}
            />
          ) : view.name === "providers" ? (
            <Providers providers={providers} quirks={quirks} pools={pools} onChanged={load} />
          ) : view.name === "quality" ? (
            <Quality pools={pools} />
          ) : (
            <Operations settings={settings} onChanged={load} />
          )}
        </main>
      </div>

      <PoolBuilder
        open={builder.open}
        editing={builder.editing}
        providers={providers}
        onClose={() => setBuilder({ open: false, editing: null })}
        onSaved={async () => {
          await load()
          setDetailToken((t) => t + 1)
        }}
      />
    </div>
  )
}
