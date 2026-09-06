import React, { useEffect, useRef, useState } from "react"
import { IconCopy, IconCheck, IconClose, IconWarning, IconInfo, IconHealthy, stateIcon } from "./icons.jsx"

// ============================================================================
// Primitives shared across screens. Kept deliberately small and unopinionated.
// ============================================================================

export function Button({ variant = "ghost", size = "md", className = "", children, ...props }) {
  const base =
    "group/btn relative inline-flex items-center justify-center gap-2 font-medium rounded-[var(--radius-inner)] select-none whitespace-nowrap transition-[background-color,color,box-shadow,transform] duration-200 ease-[var(--ease-smooth)] active:scale-[0.97] active:duration-75 disabled:opacity-40 disabled:pointer-events-none"
  const sizes = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-9 px-3.5 text-sm",
    lg: "h-11 px-5 text-sm",
  }
  const variants = {
    primary:
      "bg-[var(--color-accent-dim)] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_1px_2px_0_rgba(0,0,0,0.4)] hover:bg-[var(--color-accent)] hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18),0_2px_4px_-1px_rgba(0,0,0,0.4),0_10px_28px_-10px_var(--color-accent)]",
    solid:
      "bg-[var(--color-overlay)] text-[var(--color-ink)] shadow-[var(--shadow-hairline)] hover:bg-[#20222a] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]",
    ghost: "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] hover:bg-[var(--color-raised)]",
    danger:
      "text-[var(--color-bad)] hover:bg-[color-mix(in_oklab,var(--color-bad)_16%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-bad)_30%,transparent)]",
    outline:
      "text-[var(--color-ink-soft)] shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-[var(--color-ink)] hover:bg-[var(--color-raised)] hover:shadow-[inset_0_0_0_1px_var(--color-accent-dim)]",
  }
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function Card({ className = "", children, sheen = false, ...props }) {
  return (
    <div className={`card relative overflow-hidden ${className}`} {...props}>
      {sheen && <div aria-hidden className="panel-sheen-top pointer-events-none" />}
      {children}
    </div>
  )
}

// State is signalled by glyph + text + colour together, never colour alone.
export function StatePill({ state, meta, compact = false, className = "" }) {
  const m = meta
  const Icon = stateIcon(state)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] text-[11px] font-medium leading-none transition-colors duration-300 ${className}`}
      style={{
        color: m.color,
        background: `color-mix(in oklab, ${m.color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${m.color} 30%, transparent)`,
      }}
      title={m.label}
    >
      <Icon size={10} className={state === "healthy" ? "animate-breathe" : ""} />
      {!compact && m.label}
    </span>
  )
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-[var(--color-ink-soft)]">{label}</span>
        {hint && <span className="text-[11px] text-[var(--color-ink-faint)]">{hint}</span>}
      </div>
      {children}
      {error && <div className="mt-1.5 text-[11px] text-[var(--color-bad)]">{error}</div>}
    </label>
  )
}

const inputBase =
  "w-full rounded-[var(--radius-inner)] bg-[var(--color-base)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color] duration-200 ease-[var(--ease-smooth)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:bg-[var(--color-surface)] focus:shadow-[inset_0_0_0_1px_var(--color-accent-dim),0_0_0_3px_color-mix(in_oklab,var(--color-accent)_18%,transparent)] focus:outline-none"

export function Input({ className = "", mono = false, ...props }) {
  return <input className={`${inputBase} ${mono ? "font-mono text-[13px]" : ""} ${className}`} {...props} />
}

export function Select({ className = "", children, ...props }) {
  return (
    <select className={`${inputBase} appearance-none pr-8 ${className}`} {...props}>
      {children}
    </select>
  )
}

export function Textarea({ className = "", ...props }) {
  return <textarea className={`${inputBase} min-h-20 resize-y font-mono text-[13px] ${className}`} {...props} />
}

// Click-to-copy, with confirmation in the button itself rather than a toast.
export function CopyBadge({ value, className = "" }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        } catch {
          /* clipboard blocked; nothing useful to do */
        }
      }}
      title={copied ? "Copied" : `Copy "${value}"`}
      className={`group inline-flex items-center gap-1.5 rounded-[5px] bg-[var(--color-base)] px-1.5 py-[3px] font-mono text-[11px] text-[var(--color-ink-soft)] shadow-[inset_0_0_0_1px_var(--color-line)] transition-[color,box-shadow,background-color] duration-200 ease-[var(--ease-smooth)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)] hover:shadow-[inset_0_0_0_1px_var(--color-accent-dim)] ${className}`}
      style={copied ? { color: "var(--color-ok-soft)" } : undefined}
    >
      {value}
      <span
        aria-hidden
        className="inline-flex opacity-45 transition-opacity duration-200 group-hover:opacity-100"
      >
        {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
      </span>
    </button>
  )
}

// Health strip: one segment per key, so a pool's state is legible at a glance.
export function HealthStrip({ segments, className = "" }) {
  if (!segments.length) {
    return <div className={`h-[5px] rounded-full bg-[var(--color-line)] ${className}`} />
  }
  return (
    <div className={`animate-strip flex h-[5px] gap-px overflow-hidden rounded-full ${className}`}>
      {segments.map((s, i) => (
        <div
          key={i}
          className="flex-1 transition-colors duration-500"
          style={{ background: s.color, "--i": i }}
          title={s.title}
        />
      ))}
    </div>
  )
}

// Sparkline drawn as an SVG path; no charting dependency for two series.
export function Sparkline({ values, height = 34, color = "var(--color-accent)", fill = true, className = "" }) {
  const clean = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
  const max = Math.max(...clean, 1)
  const n = clean.length
  if (!n) return <div style={{ height }} className={className} />

  const w = 100
  const pts = clean.map((v, i) => {
    const x = n === 1 ? w : (i / (n - 1)) * w
    const y = height - (v / max) * (height - 3) - 1.5
    return [x, y]
  })
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
  const area = `${line} L${w},${height} L0,${height} Z`
  const id = `sg-${color.replace(/[^a-z]/gi, "")}`
  const last = pts[pts.length - 1]

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height, overflow: "visible" }}
      aria-hidden
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} className="animate-fade" />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        pathLength="1"
        className="animate-draw"
      />
      {/* The live end of the series gets a marker, so "now" is unambiguous. */}
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Stat({ label, value, sub, className = "" }) {
  return (
    <div className={className}>
      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">{label}</div>
      <div className="tnum mt-1.5 text-[22px] font-medium leading-none tracking-[-0.02em] text-[var(--color-ink)]">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">{sub}</div>}
    </div>
  )
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = "max-w-2xl" }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="animate-fade fixed inset-0 bg-[#050506]/72 backdrop-blur-[6px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-pop card relative z-10 my-auto w-full ${width} shadow-[var(--shadow-hairline),var(--shadow-float)]`}
      >
        <div aria-hidden className="panel-sheen-top pointer-events-none" />
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1">
            <IconClose size={13} />
          </Button>
        </header>
        <div className="px-5 py-5">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-line)] bg-[var(--color-base)]/50 px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export function Empty({ icon: Icon, title, body, action, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-16 text-center ${className}`}>
      {Icon && (
        <div
          className="animate-pop mb-4 flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-ink-soft)] shadow-[var(--shadow-hairline)]"
          style={{ background: "var(--color-raised)" }}
          aria-hidden
        >
          <Icon size={19} />
        </div>
      )}
      <h3 className="text-[13.5px] font-medium text-[var(--color-ink)]">{title}</h3>
      {body && <p className="mt-2 max-w-sm text-xs leading-relaxed text-[var(--color-ink-faint)]">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Banner({ tone = "warn", children, action, className = "" }) {
  const colors = {
    warn: "var(--color-warn)",
    bad: "var(--color-bad)",
    ok: "var(--color-ok)",
    info: "var(--color-accent)",
  }
  const icons = { warn: IconWarning, bad: IconWarning, ok: IconHealthy, info: IconInfo }
  const c = colors[tone]
  const Icon = icons[tone]
  return (
    <div
      className={`animate-slide-down flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-inner)] px-3.5 py-2.5 text-xs ${className}`}
      style={{
        background: `color-mix(in oklab, ${c} 11%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 28%, transparent)`,
        color: "var(--color-ink)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden style={{ color: c }} className="mt-[1px] flex shrink-0">
          <Icon size={13} />
        </span>
        <span className="leading-relaxed">{children}</span>
      </div>
      {action}
    </div>
  )
}

export function Spinner({ size = 14, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function Skeleton({ className = "" }) {
  return <div className={`skeleton rounded-md ${className}`} />
}
