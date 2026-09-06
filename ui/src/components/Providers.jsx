import React, { useState } from "react"
import { api } from "../api.js"
import { Card, Button, Field, Input, Select, Empty, Banner, Spinner, StatePill } from "./ui.jsx"
import { stateMeta } from "../format.js"
import { IconClose, IconPlus, IconChevronRight, stateIcon } from "./icons.jsx"
import KeyManager from "./KeyManager.jsx"

// ============================================================================
// Providers settings: edit a provider, manage its keys, park/unpark it.
// Adding a key here instantly widens every pool that uses this provider.
// ============================================================================

function ModelChips({ models, onChange }) {
  const [draft, setDraft] = useState("")

  function commit() {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    const next = [...models]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft("")
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {models.length === 0 && (
          <span className="text-[11px] text-[var(--color-ink-faint)]">No models yet — add some below.</span>
        )}
        {models.map((m) => (
          <span
            key={m}
            className="tnum inline-flex items-center gap-1.5 rounded-[5px] bg-[var(--color-base)] px-1.5 py-[3px] text-[11px] text-[var(--color-ink-soft)] shadow-[inset_0_0_0_1px_var(--color-line)]"
          >
            {m}
            <button
              onClick={() => onChange(models.filter((x) => x !== m))}
              className="flex opacity-45 transition-opacity duration-200 hover:opacity-100"
              aria-label={`Remove ${m}`}
            >
              <IconClose size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          mono
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="claude-opus-5, claude-sonnet-5"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
        />
        <Button variant="outline" size="md" onClick={commit} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      <p className="mt-1.5 text-[10.5px] text-[var(--color-ink-faint)]">
        Separate several with commas. Press Enter to add.
      </p>
    </div>
  )
}

function ProviderPanel({ provider, quirks, pools, onChanged }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const usedBy = pools.filter((p) => p.legs.some((l) => l.providerId === provider.id))
  const parked = provider.enabled === false

  function beginEdit() {
    setDraft({
      label: provider.label,
      baseURL: provider.baseURL,
      quirks: provider.quirks || [],
      models: provider.models || [],
      note: provider.note || "",
      enabled: provider.enabled !== false,
    })
  }

  async function save() {
    setBusy("save")
    setError(null)
    try {
      await api.updateProvider(provider.id, draft)
      setDraft(null)
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function discover() {
    setBusy("discover")
    setError(null)
    setNotice(null)
    try {
      const r = await api.discoverModels(provider.id)
      if (!r.ok) {
        setError(r.message || `Upstream returned ${r.status}`)
      } else {
        const target = draft ?? { models: provider.models }
        if (draft) setDraft({ ...draft, models: r.models })
        else await api.updateProvider(provider.id, { models: r.models })
        setNotice(`Found ${r.models.length} models upstream`)
        onChanged()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    const force = usedBy.length > 0
    if (
      !window.confirm(
        force
          ? `Delete ${provider.label}? It will also be removed from ${usedBy.length} pool(s): ${usedBy.map((p) => p.id).join(", ")}.`
          : `Delete ${provider.label} and its stored keys?`,
      )
    )
      return
    setBusy("delete")
    try {
      await api.deleteProvider(provider.id, force)
      onChanged()
    } catch (e) {
      setError(e.message)
      setBusy(null)
    }
  }

  async function togglePark() {
    setBusy("park")
    try {
      await api.updateProvider(provider.id, { enabled: parked })
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const keyStates = provider.keys.map((k) => ({ ...stateMeta(k.state), state: k.state }))

  return (
    <Card className={parked ? "opacity-75" : ""}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-200 hover:bg-[var(--color-raised)]/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{provider.label}</span>
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
            {(provider.quirks || []).map((q) => (
              <span
                key={q}
                className="tnum rounded-[4px] px-1.5 py-px text-[10px] text-[var(--color-accent-soft)]"
                style={{
                  background: "color-mix(in oklab, var(--color-accent) 13%, transparent)",
                  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-accent) 30%, transparent)",
                }}
                title={quirks.find((x) => x.id === q)?.description || q}
              >
                {q}
              </span>
            ))}
          </div>
          <div className="tnum mt-1 truncate text-[11px] text-[var(--color-ink-faint)]">{provider.baseURL}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {keyStates.length === 0 ? (
            <span className="text-[11px] text-[var(--color-bad)]">no keys</span>
          ) : (
            keyStates.slice(0, 6).map((m, i) => {
              const Icon = stateIcon(m.state)
              return (
                <span key={i} aria-hidden style={{ color: m.color }} className="flex" title={m.label}>
                  <Icon size={11} />
                </span>
              )
            })
          )}
        </div>

        <div className="shrink-0 text-right">
          <div className="tnum text-[13px] font-medium tracking-[-0.02em]">
            <span style={{ color: provider.usableKeyCount ? "var(--color-ok-soft)" : "var(--color-bad)" }}>
              {provider.usableKeyCount}
            </span>
            <span className="text-[var(--color-ink-faint)]">/{provider.keyCount}</span>
          </div>
          <div className="mt-0.5 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
            keys
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="tnum text-[13px] font-medium tracking-[-0.02em] text-[var(--color-ink-soft)]">
            {provider.models.length}
          </div>
          <div className="mt-0.5 text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
            models
          </div>
        </div>

        <span
          aria-hidden
          className="flex shrink-0 text-[var(--color-ink-faint)] transition-transform duration-300 ease-[var(--ease-out-quint)]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <IconChevronRight size={12} />
        </span>
      </button>

      {open && (
        <div className="animate-slide-down border-t border-[var(--color-line)]">
          {provider.disabledReason && (
            <div className="px-3.5 pt-3">
              <Banner tone="warn">{provider.disabledReason}</Banner>
            </div>
          )}
          {provider.note && !provider.disabledReason && (
            <p className="px-3.5 pt-3 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">{provider.note}</p>
          )}
          {error && (
            <div className="px-3.5 pt-3">
              <Banner tone="bad">{error}</Banner>
            </div>
          )}
          {notice && (
            <div className="px-3.5 pt-3">
              <Banner tone="ok">{notice}</Banner>
            </div>
          )}

          <div className="px-4 py-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <h4 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
                Keys
              </h4>
              {usedBy.length > 0 && (
                <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                  used by <span className="tnum">{usedBy.map((p) => p.id).join(", ")}</span>
                </span>
              )}
            </div>
            <div className="rounded-[var(--radius-inner)] bg-[var(--color-base)]/50 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <KeyManager provider={provider} onChanged={onChanged} />
            </div>
          </div>

          {draft ? (
            <div className="space-y-4 border-t border-[var(--color-line)] bg-[var(--color-base)]/50 px-4 py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Label">
                  <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                </Field>
                <Field label="Base URL" hint="must end in /v1 for most gateways">
                  <Input mono value={draft.baseURL} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
                </Field>
              </div>

              <Field label="Quirks" hint="per-provider adaptations">
                <div className="space-y-1">
                  {quirks.map((q) => (
                    <label
                      key={q.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-[6px] px-2 py-1.5 transition-colors duration-200 hover:bg-[var(--color-raised)]"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-[var(--color-accent)]"
                        checked={draft.quirks.includes(q.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            quirks: e.target.checked
                              ? [...draft.quirks, q.id]
                              : draft.quirks.filter((x) => x !== q.id),
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="tnum block text-[11.5px] text-[var(--color-ink)]">{q.id}</span>
                        <span className="block text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
                          {q.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>

              <Field
                label="Models"
                hint={
                  <button
                    onClick={discover}
                    disabled={busy === "discover"}
                    className="text-[10.5px] text-[var(--color-accent-soft)] underline-offset-2 hover:underline"
                  >
                    {busy === "discover" ? "checking…" : "fetch from upstream"}
                  </button>
                }
              >
                <ModelChips models={draft.models} onChange={(models) => setDraft({ ...draft, models })} />
              </Field>

              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={save} disabled={busy === "save"}>
                  {busy === "save" && <Spinner />}Save changes
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] bg-[var(--color-base)]/50 px-4 py-3">
              <Button size="sm" variant="outline" onClick={beginEdit}>
                Edit provider
              </Button>
              <Button size="sm" variant="ghost" onClick={discover} disabled={busy === "discover"}>
                {busy === "discover" ? <Spinner /> : "Refresh models"}
              </Button>
              <Button size="sm" variant="ghost" onClick={togglePark} disabled={busy === "park"}>
                {parked ? "Bring online" : "Park"}
              </Button>
              <div className="flex-1" />
              <Button size="sm" variant="danger" onClick={remove} disabled={busy === "delete"}>
                Delete
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function AddProvider({ quirks, onDone }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ label: "", baseURL: "", quirks: [], models: [], keyLabel: "", keyValue: "" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      await api.createProvider({
        label: form.label.trim(),
        baseURL: form.baseURL.trim(),
        quirks: form.quirks,
        models: form.models,
        keys: form.keyValue.trim()
          ? [{ label: form.keyLabel.trim() || `${form.label.trim()} key 1`, value: form.keyValue.trim() }]
          : [],
      })
      setForm({ label: "", baseURL: "", quirks: [], models: [], keyLabel: "", keyValue: "" })
      setOpen(false)
      onDone()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="group flex w-full items-center justify-center gap-2.5 rounded-[var(--radius-card)] py-4 text-[var(--color-ink-faint)] shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[box-shadow,background-color,color] duration-300 ease-[var(--ease-smooth)] hover:bg-[var(--color-surface)] hover:text-[var(--color-accent-soft)] hover:shadow-[inset_0_0_0_1px_var(--color-accent-dim)]"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-raised)] shadow-[var(--shadow-hairline)] transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-90 group-hover:scale-110"
        >
          <IconPlus size={13} />
        </span>
        <span className="text-xs font-medium">Add provider</span>
      </button>
    )
  }

  return (
    <Card sheen className="animate-pop">
      <div className="space-y-4 p-5">
        <h3 className="text-[14px] font-semibold">New provider</h3>
        {error && <Banner tone="bad">{error}</Banner>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Label" hint="shown in the UI">
            <Input
              autoFocus
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Some Gateway"
            />
          </Field>
          <Field label="Base URL">
            <Input
              mono
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
              placeholder="https://example.com/v1"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First key label">
            <Input
              value={form.keyLabel}
              onChange={(e) => setForm({ ...form, keyLabel: e.target.value })}
              placeholder="Key 1"
            />
          </Field>
          <Field label="First key value" hint="add more after saving">
            <Input
              mono
              type="password"
              value={form.keyValue}
              onChange={(e) => setForm({ ...form, keyValue: e.target.value })}
              placeholder="sk-…"
            />
          </Field>
        </div>

        <Field label="Models" hint="or fetch them after saving">
          <ModelChips models={form.models} onChange={(models) => setForm({ ...form, models })} />
        </Field>

        <Field label="Quirks">
          <div className="flex flex-wrap gap-1.5">
            {quirks.map((q) => {
              const on = form.quirks.includes(q.id)
              return (
                <button
                  key={q.id}
                  onClick={() =>
                    setForm({
                      ...form,
                      quirks: on ? form.quirks.filter((x) => x !== q.id) : [...form.quirks, q.id],
                    })
                  }
                  title={q.description}
                  className="tnum rounded-[6px] px-2 py-1 text-[11px] transition-all duration-200 ease-[var(--ease-smooth)] active:scale-95"
                  style={{
                    background: on ? "color-mix(in oklab, var(--color-accent) 16%, transparent)" : "var(--color-base)",
                    color: on ? "var(--color-accent-soft)" : "var(--color-ink-faint)",
                    boxShadow: `inset 0 0 0 1px ${on ? "color-mix(in oklab, var(--color-accent) 34%, transparent)" : "var(--color-line)"}`,
                  }}
                >
                  {q.id}
                </button>
              )
            })}
          </div>
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={create} disabled={busy || !form.label.trim() || !form.baseURL.trim()}>
            {busy && <Spinner />}Create provider
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

export default function Providers({ providers, quirks, pools, onChanged }) {
  const live = providers.filter((p) => p.enabled !== false)
  const parked = providers.filter((p) => p.enabled === false)

  return (
    <div className="stagger space-y-3">
      <p className="text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
        Keys added here are picked up by every pool using that provider — no pool edits needed. Values are never sent
        back to this page, only masks.
      </p>

      {live.map((p, i) => (
        <ProviderPanel key={p.id} provider={p} quirks={quirks} pools={pools} onChanged={onChanged} />
      ))}

      {parked.length > 0 && (
        <>
          <div className="flex items-center gap-3 pt-3">
            <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              Parked
            </h3>
            <span className="h-px flex-1 bg-[var(--color-line)]" />
            <span className="text-[10.5px] text-[var(--color-ink-faint)]">
              kept for their model lists — paste a key to bring back
            </span>
          </div>
          {parked.map((p) => (
            <ProviderPanel key={p.id} provider={p} quirks={quirks} pools={pools} onChanged={onChanged} />
          ))}
        </>
      )}

      <AddProvider quirks={quirks} onDone={onChanged} />
    </div>
  )
}
