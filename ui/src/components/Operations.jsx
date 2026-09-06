import React, { useEffect, useState } from "react"
import { api } from "../api.js"
import { Card, Button, Field, Input, Banner, Spinner } from "./ui.jsx"
import { IconRefresh, IconCheck, IconWarning } from "./icons.jsx"

// ============================================================================
// Operations — plain-language knobs. Grouped by what the thing does, not by
// config key names. Save applies everything; one explicit Save keeps surprises
// out (nothing changes until you press it).
// ============================================================================

function Group({ title, hint, children }) {
  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">{hint}</p>}
      </div>
      {children}
    </Card>
  )
}

export default function Operations({ settings: initialSettings, onChanged }) {
  const [settings, setSettings] = useState(initialSettings || {})
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [canaryStatus, setCanaryStatus] = useState(null)

  useEffect(() => {
    if (initialSettings) setSettings(initialSettings)
  }, [initialSettings])

  useEffect(() => {
    loadCanary()
  }, [])

  async function loadCanary() {
    try {
      const res = await api.getCanaryStatus()
      if (res.status) setCanaryStatus(res.status)
    } catch {}
  }

  function flash(msg, tone = "ok") {
    setNotice({ msg, tone })
    setTimeout(() => setNotice(null), 4000)
  }

  function num(key, val) {
    const n = Number(val)
    if (!isNaN(n)) setSettings((s) => ({ ...s, [key]: n }))
  }

  function bool(key, val) {
    setSettings((s) => ({ ...s, [key]: Boolean(val) }))
  }

  async function save() {
    setBusy("save")
    setError(null)
    try {
      const res = await api.updateSettings(settings)
      setSettings(res.settings)
      flash("Settings saved")
      onChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function run(name, fn, okMsg) {
    setBusy(name)
    setError(null)
    try {
      await fn()
      flash(okMsg)
      onChanged?.()
      if (name === "canary") await loadCanary()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const canaryText = canaryStatus?.lastAt
    ? `${new Date(canaryStatus.lastAt).toLocaleTimeString()} · ${canaryStatus.lastResult || "all good"}`
    : "not run yet"

  return (
    <div className="space-y-4 pb-24">
      {notice && <Banner tone={notice.tone}>{notice.msg}</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* ---------------------------------------------------------- maintenance */}
      <Group
        title="Maintenance"
        hint="Things you reach for when a provider misbehaves. Each runs immediately."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => run("rotation", () => api.restartRotation(), "Rotation restarted — keys cleared and tried from the top")}
            disabled={busy}
            title="Clear stuck keys and start every pool from its first provider"
          >
            {busy === "rotation" && <Spinner />}
            <span className="flex items-center gap-1.5">
              <IconRefresh size={13} /> Restart rotation
            </span>
          </Button>

          <Button
            variant="outline"
            onClick={() => run("revive", () => api.runRevive(), "Dead-key check finished")}
            disabled={busy}
            title="Try every key that is currently out of rotation, once"
          >
            {busy === "revive" && <Spinner />}
            Check dead keys now
          </Button>

          <Button
            variant="outline"
            onClick={() => run("canary", () => api.runCanary(), "Healthy-key check finished")}
            disabled={busy}
            title="Ping a few healthy keys to make sure they still answer"
          >
            {busy === "canary" && <Spinner />}
            Check healthy keys now
          </Button>

          <Button
            variant="outline"
            onClick={() => run("toast", () => api.testToast(), "Test toast dispatched — check your notifications")}
            disabled={busy}
            title="Fire one test notification right now"
          >
            {busy === "toast" && <Spinner />}
            Send test toast
          </Button>
        </div>
        {canaryStatus?.lastAt && (
          <p className="text-[11px] text-[var(--color-ink-faint)]">
            Last healthy-key check: <span className="tnum">{canaryText}</span>
          </p>
        )}
      </Group>

      {/* ---------------------------------------------------------- time limits */}
      <Group
        title="Time limits"
        hint="How long requests may wait before the gateway gives up and tries the next key or provider."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Wait for a provider's first answer" hint="milliseconds · default 90s">
            <Input type="number" value={settings.attemptTimeoutMs ?? 90000} onChange={(e) => num("attemptTimeoutMs", e.target.value)} />
          </Field>
          <Field label="Whole request budget" hint="milliseconds · default 3 min, across every key and provider">
            <Input type="number" value={settings.requestBudgetMs ?? 180000} onChange={(e) => num("requestBudgetMs", e.target.value)} />
          </Field>
          <Field label="Wait for the first word of a stream" hint="milliseconds · default 30s">
            <Input type="number" value={settings.firstChunkTimeoutMs ?? 30000} onChange={(e) => num("firstChunkTimeoutMs", e.target.value)} />
          </Field>
          <Field label="Wait between words once streaming" hint="milliseconds · default 60s">
            <Input type="number" value={settings.chunkTimeoutMs ?? 60000} onChange={(e) => num("chunkTimeoutMs", e.target.value)} />
          </Field>
        </div>
      </Group>

      {/* ---------------------------------------------------------- key health */}
      <Group
        title="Key health"
        hint="When a key is treated as rate-limited, dead, or skipped — and how many keys one request may try on a single provider."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Wait after a rate limit" hint="seconds · doubles each time, up to the ceiling below">
            <Input type="number" value={settings.cooldownBaseSeconds ?? 20} onChange={(e) => num("cooldownBaseSeconds", e.target.value)} />
          </Field>
          <Field label="Longest rate-limit wait" hint="seconds · default 10 min">
            <Input type="number" value={settings.cooldownMaxSeconds ?? 600} onChange={(e) => num("cooldownMaxSeconds", e.target.value)} />
          </Field>
          <Field label="Silences before a key is called dead" hint="consecutive no-answers · default 3">
            <Input type="number" value={settings.deadAfterFailures ?? 3} onChange={(e) => num("deadAfterFailures", e.target.value)} />
          </Field>
          <Field label="Error streak before a key is pulled" hint="consecutive server errors · default 3">
            <Input type="number" value={settings.errorPullAfterFailures ?? 3} onChange={(e) => num("errorPullAfterFailures", e.target.value)} />
          </Field>
          <Field label="Keys tried per provider, per request" hint="default 8 — stops a broken provider eating the whole budget">
            <Input type="number" value={settings.maxKeysPerLeg ?? 8} onChange={(e) => num("maxKeysPerLeg", e.target.value)} />
          </Field>
        </div>
      </Group>

      {/* ---------------------------------------------------------- background */}
      <Group
        title="Background checks"
        hint="Automatic checks that run while you're away, so a fixed key comes back and a dying one is noticed."
      >
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={settings.reviveProbe ?? true}
              onChange={(e) => bool("reviveProbe", e.target.checked)}
            />
            <span>
              <span className="font-medium text-[var(--color-ink)]">Retry dead keys automatically</span>
              <span className="ml-1 text-[var(--color-ink-faint)]">— brings back keys you've topped up or fixed</span>
            </span>
          </label>

          {settings.reviveProbe && (
            <div className="grid grid-cols-1 gap-3 pl-6 sm:grid-cols-2">
              <Field label="How often" hint="minutes · default 5">
                <Input type="number" value={settings.reviveIntervalMinutes ?? 5} onChange={(e) => num("reviveIntervalMinutes", e.target.value)} />
              </Field>
              <Field label="Dead keys checked per pass" hint="default 20">
                <Input type="number" value={settings.reviveMaxPerTick ?? 20} onChange={(e) => num("reviveMaxPerTick", e.target.value)} />
              </Field>
            </div>
          )}

          <hr className="border-[var(--color-line)]" />

          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={settings.canaryEnabled ?? false}
              onChange={(e) => bool("canaryEnabled", e.target.checked)}
            />
            <span>
              <span className="font-medium text-[var(--color-ink)]">Check healthy keys in the background</span>
              <span className="ml-1 text-[var(--color-ink-faint)]">— pings a few so a silently dying provider shows up early</span>
            </span>
          </label>

          {settings.canaryEnabled && (
            <div className="grid grid-cols-1 gap-3 pl-6 sm:grid-cols-2">
              <Field label="How often" hint="minutes · default 15">
                <Input type="number" value={settings.canaryIntervalMinutes ?? 15} onChange={(e) => num("canaryIntervalMinutes", e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      </Group>

      {/* -------------------------------------------------------------- notices */}
      <Group
        title="Notifications & history"
        hint="Only losses and switches are announced. Rate limits and timeouts rotate silently — that is the system working."
      >
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              className="accent-[var(--color-accent)]"
              checked={settings.notifyFailover ?? true}
              onChange={(e) => bool("notifyFailover", e.target.checked)}
            />
            <span>
              <span className="font-medium text-[var(--color-ink)]">Tell me when a key or provider drops out</span>
              <span className="ml-1 text-[var(--color-ink-faint)]">— and when one comes back</span>
            </span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {settings.notifyFailover !== false && (
              <Field label="Quiet gap between notices" hint="minutes · default 2 · 0 shows every event">
                <Input type="number" value={settings.notifyCooldownMinutes ?? 2} onChange={(e) => num("notifyCooldownMinutes", e.target.value)} />
              </Field>
            )}
            <Field label="Keep call history" hint="days · default 14">
              <Input type="number" value={settings.metricsRetainDays ?? 14} onChange={(e) => num("metricsRetainDays", e.target.value)} />
            </Field>
          </div>
        </div>
      </Group>

      {/* ---------------------------------------------------------------- save */}
      <div className="fixed bottom-0 right-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-base)]/85 px-6 py-2.5 backdrop-blur-xl">
        <Button variant="primary" onClick={save} disabled={busy === "save"}>
          {busy === "save" && <Spinner />} Save settings
        </Button>
      </div>
    </div>
  )
}
