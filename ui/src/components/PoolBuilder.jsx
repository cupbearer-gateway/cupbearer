import React, { useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { slugify } from "../format.js"
import { Modal, Button, Field, Input, Select, Empty, Banner, Spinner } from "./ui.jsx"
import { IconCheck, IconClose, IconPool, IconGrip, IconChevronUp, IconChevronDown } from "./icons.jsx"

// ============================================================================
// Pool builder — the flow you described, as three steps:
//   1. Name it        (live id preview)
//   2. Add providers  (pick a provider, its models appear, click one to add)
//   3. Order them     (drag; position 1 is tried first)
// ============================================================================

const STEPS = ["Name", "Providers", "Order"]

function StepRail({ step }) {
  return (
    <ol className="mb-6 flex items-center gap-2">
      {STEPS.map((label, i) => {
        const active = i === step
        const done = i < step
        return (
          <li key={label} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className="tnum flex h-[22px] w-[22px] items-center justify-center rounded-full text-[10px] font-semibold transition-all duration-300 ease-[var(--ease-spring)]"
                style={{
                  background: active
                    ? "var(--color-accent-dim)"
                    : done
                      ? "color-mix(in oklab, var(--color-ok) 20%, transparent)"
                      : "var(--color-overlay)",
                  boxShadow: active
                    ? "0 0 0 3px color-mix(in oklab, var(--color-accent) 20%, transparent)"
                    : "var(--shadow-hairline)",
                  color: active ? "#fff" : done ? "var(--color-ok-soft)" : "var(--color-ink-soft)",
                }}
              >
                {done ? <IconCheck size={11} /> : i + 1}
              </span>
              <span
                className="text-[11.5px] font-medium transition-colors duration-300"
                style={{ color: active ? "var(--color-ink)" : "var(--color-ink-faint)" }}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span
                className="h-px w-6 transition-colors duration-300"
                style={{ background: done ? "color-mix(in oklab, var(--color-ok) 40%, transparent)" : "var(--color-line)" }}
                aria-hidden
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Step 2. Provider picker on the left; every model that provider serves as a
// click-to-add list. Added legs accumulate on the right, each with a working
// remove button. This mirrors the mental model: pick provider, pick model,
// it's in the pool.
// ---------------------------------------------------------------------------

function ProviderPicker({ providers, addedLegs, onAdd }) {
  const [providerId, setProviderId] = useState("")
  const provider = providers.find((p) => p.id === providerId)
  const addedModelsForProvider = useMemo(
    () => new Set(addedLegs.filter((l) => l.providerId === providerId).map((l) => l.model)),
    [addedLegs, providerId],
  )

  function addModel(model) {
    onAdd({ providerId, model })
  }

  return (
    <div className="space-y-3">
      <Field label="Select provider">
        <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">Choose a provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.enabled === false ? " (parked)" : ""}
            </option>
          ))}
        </Select>
      </Field>

      {provider && (
        <div className="animate-slide-down">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              Models on {provider.label}
            </span>
            <span className="text-[10.5px] text-[var(--color-ink-faint)]">
              <span className="tnum">{provider.keys.length}</span> key{provider.keys.length === 1 ? "" : "s"}
              {provider.usableKeyCount > 0 ? ` · ${provider.usableKeyCount} usable` : " · none usable"}
            </span>
          </div>

          {provider.models.length === 0 ? (
            <div className="rounded-[var(--radius-inner)] px-3 py-5 text-center text-[11.5px] text-[var(--color-ink-faint)] shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
              This provider has no models listed. Add some under Providers → Edit provider.
            </div>
          ) : (
            <ul className="stagger max-h-60 divide-y divide-[var(--color-line)] overflow-y-auto rounded-[var(--radius-inner)] bg-[var(--color-base)] shadow-[inset_0_0_0_1px_var(--color-line)]">
              {provider.models.map((m, i) => {
                const added = addedModelsForProvider.has(m)
                return (
                  <li
                    key={m}
                    className="flex items-center gap-3 px-3 py-2 transition-colors duration-200 hover:bg-[var(--color-raised)]/50"
                    style={{ "--i": i }}
                  >
                    <button
                      onClick={() => addModel(m)}
                      disabled={added}
                      className="tnum min-w-0 flex-1 truncate text-left text-[12px] text-[var(--color-ink)] transition-colors duration-200 hover:text-[var(--color-accent-soft)] disabled:cursor-default disabled:text-[var(--color-ink-faint)]"
                    >
                      {m}
                    </button>
                    {added ? (
                      <span
                        className="animate-pop flex shrink-0 items-center gap-1 text-[10.5px]"
                        style={{ color: "var(--color-ok-soft)" }}
                      >
                        <IconCheck size={11} /> added
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => addModel(m)} className="shrink-0">
                        Add
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AddedLegs({ legs, providers, onRemove }) {
  if (!legs.length) {
    return (
      <div className="rounded-[var(--radius-inner)] px-3 py-7 text-center text-[11.5px] text-[var(--color-ink-faint)] shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
        Nothing added yet. Pick a provider and click a model to add it.
      </div>
    )
  }

  return (
    <ul className="stagger space-y-1.5">
      {legs.map((leg, i) => {
        const p = providers.find((x) => x.id === leg.providerId)
        const parked = p?.enabled === false
        return (
          <li
            key={`${leg.providerId}-${leg.model}`}
            style={{ "--i": i }}
            className="group flex items-center gap-3 rounded-[var(--radius-inner)] bg-[var(--color-base)] px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow duration-200 hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          >
            <span className="tnum flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-[var(--color-overlay)] text-[10px] font-semibold text-[var(--color-ink-faint)] shadow-[var(--shadow-hairline)]">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium">{p?.label || leg.providerId}</span>
                {parked && <span className="text-[10px] text-[var(--color-warn)]">parked</span>}
              </div>
              <div className="tnum truncate text-[11px] text-[var(--color-ink-faint)]">{leg.model}</div>
            </div>
            <span className="tnum shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">
              {p?.keys?.length || 0} key{(p?.keys?.length || 0) === 1 ? "" : "s"}
            </span>
            <button
              onClick={() => onRemove(i)}
              aria-label={`Remove ${p?.label || leg.providerId}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-ink-faint)] opacity-0 transition-all duration-200 hover:bg-[color-mix(in_oklab,var(--color-bad)_16%,transparent)] hover:text-[var(--color-bad)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              <IconClose size={11} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Step 3. Drag to reorder; keyboard users get arrow buttons.
// ---------------------------------------------------------------------------

function OrderList({ providers, legs, setLegs }) {
  const [dragIndex, setDragIndex] = useState(null)
  const [overIndex, setOverIndex] = useState(null)

  function move(from, to) {
    if (to < 0 || to >= legs.length || from === to) return
    const next = legs.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setLegs(next)
  }

  return (
    <ul className="space-y-1.5">
      {legs.map((leg, i) => {
        const provider = providers.find((p) => p.id === leg.providerId)
        const parked = provider?.enabled === false
        const noKeys = !provider?.keys?.length
        const isOver = overIndex === i && dragIndex !== null && dragIndex !== i

        return (
          <li
            key={`${leg.providerId}-${leg.model}-${i}`}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setOverIndex(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex !== null) move(dragIndex, i)
              setDragIndex(null)
              setOverIndex(null)
            }}
            className="group flex cursor-grab items-center gap-3 rounded-[var(--radius-inner)] bg-[var(--color-base)] px-2.5 py-2 transition-all duration-200 ease-[var(--ease-smooth)] active:cursor-grabbing"
            style={{
              boxShadow: isOver
                ? "inset 0 0 0 1px var(--color-accent-dim), 0 0 0 3px color-mix(in oklab, var(--color-accent) 15%, transparent)"
                : "inset 0 0 0 1px var(--color-line)",
              opacity: dragIndex === i ? 0.4 : 1,
              transform: isOver ? "translateY(2px) scale(1.005)" : "none",
            }}
          >
            <span
              aria-hidden
              className="flex text-[var(--color-ink-faint)] transition-colors duration-200 group-hover:text-[var(--color-ink-soft)]"
            >
              <IconGrip size={13} />
            </span>
            <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-overlay)] text-[11px] font-semibold text-[var(--color-ink-soft)] shadow-[var(--shadow-hairline)]">
              {i + 1}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{provider?.label || leg.providerId}</span>
                {parked && <span className="text-[10px] text-[var(--color-warn)]">parked</span>}
                {noKeys && <span className="text-[10px] text-[var(--color-bad)]">no keys</span>}
              </div>
              <div className="tnum truncate text-[11px] text-[var(--color-ink-faint)]">{leg.model}</div>
            </div>

            <div className="flex shrink-0 flex-col gap-px">
              <button
                onClick={() => move(i, i - 1)}
                disabled={i === 0}
                aria-label={`Move ${provider?.label || leg.providerId} up`}
                className="flex px-1 text-[var(--color-ink-faint)] transition-colors duration-200 hover:text-[var(--color-ink)] disabled:opacity-25"
              >
                <IconChevronUp size={11} />
              </button>
              <button
                onClick={() => move(i, i + 1)}
                disabled={i === legs.length - 1}
                aria-label={`Move ${provider?.label || leg.providerId} down`}
                className="flex px-1 text-[var(--color-ink-faint)] transition-colors duration-200 hover:text-[var(--color-ink)] disabled:opacity-25"
              >
                <IconChevronDown size={11} />
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default function PoolBuilder({ open, onClose, providers, editing, onSaved }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  const [idTouched, setIdTouched] = useState(false)
  const [legs, setLegs] = useState([])
  const [keyStrategy, setKeyStrategy] = useState("round-robin")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const isEdit = Boolean(editing)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setError(null)
    setSaving(false)
    if (editing) {
      setName(editing.name)
      setId(editing.id)
      setIdTouched(true)
      setKeyStrategy(editing.keyStrategy || "round-robin")
      setLegs(editing.legs.map((l) => ({ providerId: l.providerId, model: l.model })))
    } else {
      setName("")
      setId("")
      setIdTouched(false)
      setKeyStrategy("round-robin")
      setLegs([])
    }
  }, [open, editing])

  const effectiveId = idTouched ? id : slugify(name)

  function addLeg(leg) {
    setLegs((current) => {
      const dup = current.some((l) => l.providerId === leg.providerId && l.model === leg.model)
      return dup ? current : [...current, leg]
    })
  }

  function removeLeg(index) {
    setLegs((current) => current.filter((_, i) => i !== index))
  }

  const canAdvance = useMemo(() => {
    if (step === 0) return name.trim().length > 0 && effectiveId.length > 0
    if (step === 1) return legs.length > 0
    return true
  }, [step, name, effectiveId, legs.length])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const payload = { name: name.trim(), id: effectiveId, keyStrategy, legs }
      const result = isEdit ? await api.updatePool(editing.id, payload) : await api.createPool(payload)
      onSaved(result)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${editing?.name}` : "Create a pool"}
      subtitle="One model name, several providers, tried in the order you choose."
      width="max-w-3xl"
      footer={
        <>
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={saving}>
              Back
            </Button>
          )}
          <div className="flex-1" />
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={save} disabled={saving || !legs.length}>
              {saving && <Spinner />}
              {isEdit ? "Save changes" : "Create pool"}
            </Button>
          )}
        </>
      }
    >
      <StepRail step={step} />

      {error && (
        <div className="mb-4">
          <Banner tone="bad">{error}</Banner>
        </div>
      )}

      {step === 0 && (
        <div className="animate-in space-y-4">
          <Field label="Pool name" hint="What you'll call it">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Opus 5"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdvance) setStep(1)
              }}
            />
          </Field>

          <Field
            label="Model id"
            hint="the name clients will call"
            error={effectiveId && !/^[a-zA-Z0-9._-]+$/.test(effectiveId) ? "Letters, digits, dot, dash, underscore only" : null}
          >
            <Input
              mono
              value={effectiveId}
              onChange={(e) => {
                setIdTouched(true)
                setId(e.target.value)
              }}
              placeholder="opus-5"
            />
          </Field>

          <Field label="Key & provider order" hint="How keys are chosen on each provider">
            <Select value={keyStrategy} onChange={(e) => setKeyStrategy(e.target.value)}>
              <option value="round-robin">Even distribution (Round robin)</option>
              <option value="fastest-first">Fastest first (Try lowest latency keys first)</option>
              <option value="quality">Quality first (Prefer highest-performing providers)</option>
              <option value="sticky-until-error">Sticky (Stay on current key until error)</option>
            </Select>
          </Field>

          {effectiveId && (
            <div className="animate-slide-down rounded-[var(--radius-inner)] bg-[var(--color-base)] px-3 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <div className="text-[9.5px] font-medium uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
                Clients will call this model
              </div>
              <code className="tnum mt-1.5 block text-[14px] text-[var(--color-accent-soft)]">
                {effectiveId}
              </code>
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="animate-in grid grid-cols-1 gap-4 md:grid-cols-[1.1fr_1fr]">
          <div>
            <h4 className="mb-2.5 text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              1 · Choose a provider
            </h4>
            <ProviderPicker providers={providers} addedLegs={legs} onAdd={addLeg} />
          </div>

          <div className="md:border-l md:border-[var(--color-line)] md:pl-4">
            <h4 className="mb-2.5 text-[9.5px] font-semibold uppercase tracking-[0.11em] text-[var(--color-ink-faint)]">
              2 · In this pool ({legs.length})
            </h4>
            <AddedLegs legs={legs} providers={providers} onRemove={removeLeg} />
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
              Every key on a provider is used automatically. Reorder them on the next step.
            </p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="animate-in space-y-3">
          <p className="text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
            Drag to reorder. Position 1 is tried first; if every key there is rate limited, rejected, or out of quota,
            Cupbearer moves down the list automatically.
          </p>
          {legs.length ? (
            <OrderList providers={providers} legs={legs} setLegs={setLegs} />
          ) : (
            <Empty icon={IconPool} title="No providers added" body="Go back a step and add at least one." />
          )}
        </div>
      )}
    </Modal>
  )
}
