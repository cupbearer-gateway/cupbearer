import React, { useState } from "react"
import { api } from "../api.js"
import { stateMeta, reasonLabel, ms, ago, compact } from "../format.js"
import { Button, Input, StatePill, Spinner } from "./ui.jsx"
import { IconPlus, IconEdit } from "./icons.jsx"

// Key list for one provider. Values stay masked on the page; the full value is
// only fetched when you click Reveal while editing a key.

function KeyRow({ providerId, k, testModel, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(k.label)
  const [value, setValue] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [origValue, setOrigValue] = useState("")
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
        setResult({ ok: true, text: "Back in rotation" })
      } else if (action === "reveal") {
        if (!window.confirm("Show the full key value? It will be visible on this screen.")) return
        const r = await api.getKeyValue(providerId, k.id)
        setValue(r.value || "")
        setOrigValue(r.value || "")
        setRevealed(true)
        setResult(null)
      } else if (action === "save") {
        const patch = { label }
        if (value.trim() && value.trim() !== origValue) patch.value = value.trim()
        await api.updateKey(providerId, k.id, patch)
        setEditing(false)
        setValue("")
        setRevealed(false)
        setOrigValue("")
      } else if (action === "delete") {
        if (!window.confirm(`Remove key "${k.label}"?`)) return
        await api.deleteKey(providerId, k.id)
      }
      onChanged?.()
    } catch (e) {
      setResult({ ok: false, text: e.message })
    } finally {
      setBusy(null)
      setTimeout(() => setResult(null), 6000)
    }
  }

  if (editing) {
    return (
      <div className="animate-slide-down space-y-2.5 bg-[var(--color-base)]/70 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-[var(--color-ink-soft)]">Editing key</span>
          <span className="tnum text-[10.5px] text-[var(--color-ink-faint)]">{k.masked || "no value stored"}</span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Key label" />
          {revealed ? (
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={2}
              className="w-full rounded-[6px] border border-[var(--color-line)] bg-[var(--color-base)] p-2 font-mono text-[10.5px] text-[var(--color-ink)] focus:outline-none"
            />
          ) : (
            <div className="flex items-center gap-2">
              <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--color-line)] bg-[var(--color-base)] px-2 py-1.5 text-[10.5px] text-[var(--color-ink-faint)]">
                •••••••••••••• (hidden)
              </div>
              <Button size="sm" variant="outline" onClick={() => run("reveal")} disabled={busy === "reveal"}>
                {busy === "reveal" ? <Spinner /> : "Show value"}
              </Button>
            </div>
          )}
        </div>
        <p className="text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
          {revealed
            ? "Edit the value here and press Save to replace it — or Remove key to delete it."
            : "Show value to see or replace it. Removing the key deletes it for good."}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => run("save")} disabled={busy === "save"}>
            {busy === "save" && <Spinner />}Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="danger" onClick={() => run("delete")} disabled={busy === "delete"}>
            {busy === "delete" && <Spinner />}Remove key
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-3 py-3 transition-colors duration-200 hover:bg-[var(--color-raised)]/50">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{k.label}</div>
          <div className="tnum mt-0.5 text-[10.5px] text-[var(--color-ink-faint)]">
            {k.masked || "no value stored"}
            {k.calls ? ` · ${compact(k.calls)} calls · p50 ${ms(k.p50Ms)}` : " · unused"}
          </div>
        </div>

        <StatePill state={k.state} meta={m} className="shrink-0" />

        <div className="flex shrink-0 items-center gap-1">
          {k.sticky && (
            <Button size="sm" variant="ghost" onClick={() => run("clear")} disabled={busy} title="Return to rotation">
              {busy === "clear" ? <Spinner /> : "Reset"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => run("test")} disabled={busy || !k.present}>
            {busy === "test" ? <Spinner /> : "Test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit key" className="px-2">
            <IconEdit size={12} />
          </Button>
        </div>
      </div>

      {(result || k.message) && (
        <div className="animate-fade mt-2 flex items-start gap-2 text-[10.5px]">
          {result ? (
            <span style={{ color: result.ok ? "var(--color-ok-soft)" : "var(--color-bad)" }}>{result.text}</span>
          ) : (
            <>
              <span className="shrink-0 text-[var(--color-ink-faint)]">
                {reasonLabel(k.reason)} · {ago(k.lastErrorAt)}
              </span>
              <code className="min-w-0 flex-1 truncate text-[var(--color-ink-faint)]" title={k.message}>
                {k.message}
              </code>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function KeyManager({ provider, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState("single") // "single" | "bulk"
  const [label, setLabel] = useState("")
  const [value, setValue] = useState("")
  const [bulkText, setBulkText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const testModel = provider.models?.[0]

  async function add() {
    setBusy(true)
    setError(null)
    try {
      if (mode === "bulk") {
        const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean)
        const keys = []
        lines.forEach((line, idx) => {
          const parts = line.split(/[\t,]+/)
          if (parts.length >= 2) {
            keys.push({ label: parts[0].trim(), value: parts[1].trim() })
          } else {
            keys.push({ label: `Key ${provider.keys.length + idx + 1}`, value: line })
          }
        })
        await api.bulkAddKeys(provider.id, keys, true)
        setBulkText("")
      } else {
        await api.addKey(provider.id, {
          label: label.trim() || `${provider.label} key ${provider.keys.length + 1}`,
          value: value.trim(),
        })
        setLabel("")
        setValue("")
      }
      setAdding(false)
      onChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="divide-y divide-[var(--color-line)]">
        {provider.keys.map((k) => (
          <KeyRow key={k.id} providerId={provider.id} k={k} testModel={testModel} onChanged={onChanged} />
        ))}
      </div>

      {provider.keys.length === 0 && !adding && (
        <div className="px-3 py-3 text-[11.5px] text-[var(--color-ink-faint)]">
          No keys stored. This provider cannot serve any pool until you add one.
        </div>
      )}

      {adding ? (
        <div className="animate-slide-down space-y-2.5 border-t border-[var(--color-line)] bg-[var(--color-base)]/70 px-3 py-3">
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => setMode("single")}
              className={`text-[11px] font-medium px-2 py-0.5 rounded ${mode === "single" ? "bg-[var(--color-overlay)] text-[var(--color-ink)]" : "text-[var(--color-ink-faint)]"}`}
            >
              Single key
            </button>
            <button
              onClick={() => setMode("bulk")}
              className={`text-[11px] font-medium px-2 py-0.5 rounded ${mode === "bulk" ? "bg-[var(--color-overlay)] text-[var(--color-ink)]" : "text-[var(--color-ink-faint)]"}`}
            >
              Paste multiple keys
            </button>
          </div>

          {mode === "single" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={`${provider.label} key ${provider.keys.length + 1}`}
              />
              <Input
                mono
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && value.trim()) add()
                }}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <textarea
                autoFocus
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder="Paste keys here (one per line, or Label [tab] sk-key)"
                className="w-full h-28 p-2 font-mono text-[11px] rounded bg-[var(--color-base)] border border-[var(--color-line)] text-[var(--color-ink)] focus:outline-none"
              />
              <p className="text-[10px] text-[var(--color-ink-faint)]">
                One per line. Optional format: <code className="tnum">Label [tab] key_value</code>
              </p>
            </div>
          )}

          {error && <div className="text-[10.5px] text-[var(--color-bad)]">{error}</div>}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={add} disabled={busy || (mode === "single" ? !value.trim() : !bulkText.trim())}>
              {busy && <Spinner />}{mode === "single" ? "Add key" : "Import keys"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-[var(--color-line)] px-3 py-2.5">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} className="group/add">
            <span className="flex transition-transform duration-300 ease-[var(--ease-spring)] group-hover/add:rotate-90">
              <IconPlus size={12} />
            </span>
            Add key
          </Button>
        </div>
      )}
    </div>
  )
}
