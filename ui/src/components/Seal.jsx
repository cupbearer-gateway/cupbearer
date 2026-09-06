import React from "react"

// The wax seal — Cupbearer's signature verdict mark. A scalloped wax disc with
// an inner ring and the verdict lettering, stamped once (`.seal-stamp` handles
// the press animation; `prefers-reduced-motion` flattens it globally).
//
// verdict: "held" (emerald) | "blocked" (oxblood) | "shadow" (amber)
// The wax edge is generated as a 12-scallop path so it stays crisp at any size
// and gets a hand-pressed irregularity without raster assets.

const COLORS = {
  held: "var(--color-ok)",
  blocked: "var(--color-bad)",
  shadow: "var(--color-warn)",
}

const LABELS = {
  held: ["TASTED", "HELD"],
  blocked: ["BLOCKED", "REROUTED"],
  shadow: ["TASTED", "LOGGED"],
}

function waxPath(cx, cy, rOuter, rInner, bumps) {
  const pts = []
  for (let i = 0; i < bumps; i++) {
    const a = (i / bumps) * Math.PI * 2 - Math.PI / 2
    // Alternate slightly irregular radii: wax never pours perfectly round.
    const irregular = i % 3 === 0 ? 0.96 : i % 2 === 0 ? 1.03 : 1
    pts.push([cx + Math.cos(a) * rOuter * irregular, cy + Math.sin(a) * rOuter * irregular])
  }
  let d = ""
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const nx = mx + (mx - cx) * (rInner / rOuter - 1) * 1.6
    const ny = my + (my - cy) * (rInner / rOuter - 1) * 1.6
    d += (i === 0 ? `M ${x1.toFixed(2)} ${y1.toFixed(2)}` : "") + ` Q ${nx.toFixed(2)} ${ny.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }
  return d + " Z"
}

export default function Seal({ verdict = "held", size = 34, animate = false, title }) {
  const color = COLORS[verdict] || COLORS.held
  const [top, bottom] = LABELS[verdict] || LABELS.held
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={animate ? "seal-stamp" : undefined}
      role="img"
      aria-label={title || `${verdict} seal`}
      style={{ flex: "none", transform: animate ? undefined : "rotate(-3deg)" }}
    >
      <path d={waxPath(50, 50, 47, 42, 12)} fill={color} opacity="0.16" />
      <path d={waxPath(50, 50, 47, 42, 12)} fill="none" stroke={color} strokeWidth="3.5" />
      <circle cx="50" cy="50" r="34" fill="none" stroke={color} strokeWidth="1.6" opacity="0.75" strokeDasharray="2.5 3" />
      <text
        x="50"
        y="45.5"
        textAnchor="middle"
        fill={color}
        style={{ font: '600 13.5px var(--font-serif)', letterSpacing: "0.08em" }}
      >
        {top}
      </text>
      <text
        x="50"
        y="60.5"
        textAnchor="middle"
        fill={color}
        opacity="0.85"
        style={{ font: '600 9.5px var(--font-serif)', letterSpacing: "0.12em" }}
      >
        {bottom}
      </text>
    </svg>
  )
}
