import React, { useCallback, useEffect, useRef, useState } from "react"
import { api, subscribeEvents } from "./api.js"
import { compact, pct, ms } from "./format.js"
import { Button, Banner, Skeleton, Empty, Card } from "./components/ui.jsx"
import { Logo, IconWarning, IconPool, IconServer, IconSliders, IconRail, IconLayers, IconClose } from "./components/icons.jsx"
import PoolsGrid from "./components/PoolsGrid.jsx"
import PoolDetail from "./components/PoolDetail.jsx"
import PoolBuilder from "./components/PoolBuilder.jsx"
import Providers from "./components/Providers.jsx"
import Operations from "./components/Operations.jsx"
import Quality from "./components/Quality.jsx"
import Stream from "./components/Stream.jsx"

// ============================================================================
// Shell: collapsible side nav, a calm top bar per view, and routing between the
// views. Data comes from /api/overview; SSE nudges a refetch so the UI
// tracks real traffic without polling hard.
// ============================================================================

const VIEWS = [
  { name: "stream", label: "Stream", icon: IconRail },
  { name: "pools", label: "Pools", icon: IconPool },
  { name: "evidence", label: "Evidence", icon: IconLayers },
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
  const [view, setView] = useState({ name: "stream" })
  const [collapsed, setCollapsed] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [connected, setConnected] = useState(false)
  const [pulse, setPulse] = useState(false)
  const [builder, setBuilder] = useState({ open: false, editing: null })
  const [detailToken, setDetailToken] = useState(0)
  const [poolsTab, setPoolsTab] = useState("pools")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(() => !localStorage.getItem("cupbearer-welcomed"))

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
              <img src="/logo.png" alt="" className="h-[24px] w-[24px] rounded-[6px]" />
              <span className="brand-serif text-[17px] font-semibold tracking-[-0.01em]">Cupbearer</span>
            </button>
          )}
          {collapsed && (
            <button onClick={() => setView({ name: "stream" })} aria-label="Cupbearer home" className="flex justify-center">
              <img src="/logo.png" alt="" className="h-[24px] w-[24px] rounded-[6px]" />
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
              count={v.name === "pools" ? pools.length : undefined}
              collapsed={collapsed}
              onClick={() => setView({ name: v.name })}
            />
          ))}
        </nav>

        <div className="flex-1" />

        {/* Settings drawer trigger — the only way in; knobs are not a page. */}
        <div className={`border-t border-[var(--color-line)] ${collapsed ? "px-0 py-2" : "px-2 py-2"}`}>
          <NavItem
            active={settingsOpen}
            icon={IconSliders}
            label="Settings"
            collapsed={collapsed}
            onClick={() => setSettingsOpen(true)}
          />
        </div>

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
          ) : view.name === "stream" ? (
            <Stream />
          ) : view.name === "pools" ? (
            <>
              <div className="flex items-center gap-1.5">
                {[
                  { id: "pools", label: `Pools (${pools.length})` },
                  { id: "providers", label: `Providers (${providers.length})` },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setPoolsTab(t.id)}
                    className={`rounded-[var(--radius-inner)] px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 ${
                      poolsTab === t.id ? "text-[var(--color-ink)]" : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]"
                    }`}
                    style={
                      poolsTab === t.id
                        ? { background: "color-mix(in oklab, var(--color-accent) 13%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-accent) 30%, transparent)" }
                        : { boxShadow: "inset 0 0 0 1px var(--color-line)" }
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {deadKeys.length > 0 && poolsTab === "pools" && (
                <Banner
                  tone="warn"
                  action={
                    <Button size="sm" variant="outline" onClick={() => setPoolsTab("providers")}>
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
              {poolsTab === "pools" ? (
                <PoolsGrid
                  pools={pools}
                  onOpen={(id) => setView({ name: "pool", id })}
                  onCreate={() => setBuilder({ open: true, editing: null })}
                  onEdit={(pool) => setBuilder({ open: true, editing: pool })}
                />
              ) : (
                <Providers providers={providers} quirks={quirks} pools={pools} onChanged={load} />
              )}
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
          ) : (
            <Quality pools={pools} />
          )}
        </main>
      </div>

        {/* Settings drawer — knobs are a layer, not a destination. */}
        {settingsOpen && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setSettingsOpen(false)} />
            <aside
              className="animate-fade relative flex h-full w-full max-w-[560px] flex-col border-l border-[var(--color-line)] bg-[var(--color-base)]"
              role="dialog"
              aria-label="Settings"
            >
              <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-4">
                <h2 className="brand-serif text-[15px] font-semibold">Settings</h2>
                <div className="flex-1" />
                <button
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close settings"
                  className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
                >
                  <IconClose size={14} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <Operations settings={settings} onChanged={load} />
              </div>
            </aside>
          </div>
        )}

        {/* First-run welcome: what to expect, why this is different. */}
        {data && welcomeOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => { localStorage.setItem("cupbearer-welcomed", "1"); setWelcomeOpen(false) }} />
            <Card sheen className="animate-pop relative w-full max-w-[560px] p-6">
              <div className="flex items-center gap-3">
                <img src="/logo.png" alt="" className="h-11 w-11 rounded-[10px]" />
                <div>
                  <h2 className="brand-serif text-[20px] font-semibold">Welcome to the tasting room</h2>
                  <p className="text-[12px] text-[var(--color-ink-faint)]">Every request gets tasted before it's served.</p>
                </div>
              </div>
              <ol className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
                <li>
                  <span className="font-medium text-[var(--color-ink)]">Stream</span> — your requests, live. Easy tasks ride your cheapest
                  keys; harder ones get verified: the answer is checked before your client ever sees it.
                </li>
                <li>
                  <span className="font-medium text-[var(--color-ink)]">Pools</span> — keys and legs. Add more legs to a pool and cheap
                  answers get quality-checked against stronger backups automatically.
                </li>
                <li>
                  <span className="font-medium text-[var(--color-ink)]">Evidence</span> — every verdict logged. Turn a pool's gate to{" "}
                  <span className="tnum">shadow</span> to build proof, then <span className="tnum">gate</span> to start blocking.
                </li>
              </ol>
              <div className="mt-5 flex items-center justify-between">
                <span className="text-[11px] text-[var(--color-ink-faint)]">loopback only — your keys never leave this machine</span>
                <Button variant="primary" onClick={() => { localStorage.setItem("cupbearer-welcomed", "1"); setWelcomeOpen(false) }}>
                  Start tasting
                </Button>
              </div>
            </Card>
          </div>
        )}

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
