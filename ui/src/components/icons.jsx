import React from "react"

// ============================================================================
// Icon set. Hand-drawn 16-unit grid, 1.5 stroke, round caps — one consistent
// weight so a row of mixed icons reads as one family. Every icon inherits
// currentColor and sizes from a single `size` prop.
//
// These replace the Unicode glyphs the UI used to lean on: those inherited
// whatever the system font decided, so weight and baseline drifted per glyph.
// ============================================================================

function Svg({ size = 14, children, className = "", ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  )
}

/* --------------------------------------------------------------- key states */

// Healthy: a filled dot inside a ring. Solid centre = carrying traffic.
export const IconHealthy = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.25" opacity="0.4" />
    <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
  </Svg>
)

// Degraded: a triangle. Distinct silhouette, not just a different colour.
export const IconDegraded = (p) => (
  <Svg {...p}>
    <path d="M8 2.6 14 13H2L8 2.6Z" fill="currentColor" fillOpacity="0.18" />
    <path d="M8 6.4v3" />
    <path d="M8 11.3h.01" />
  </Svg>
)

// Cooling: a half-filled clock — time is what fixes this one.
export const IconCooling = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" opacity="0.5" />
    <path d="M8 2.25A5.75 5.75 0 0 1 8 13.75Z" fill="currentColor" stroke="none" fillOpacity="0.55" />
    <path d="M8 5.1V8l2 1.6" />
  </Svg>
)

// Dead / rejected / out of quota: an X in a ring.
export const IconDead = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" opacity="0.45" />
    <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
  </Svg>
)

// Unknown.
export const IconUnknown = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" strokeDasharray="2.2 2.2" opacity="0.7" />
  </Svg>
)

/* ------------------------------------------------------------------ actions */

export const IconCopy = (p) => (
  <Svg {...p}>
    <rect x="6" y="6" width="7.5" height="7.5" rx="1.75" />
    <path d="M10 3.6a1.6 1.6 0 0 0-1.35-1.1H4.1A1.6 1.6 0 0 0 2.5 4.1v4.55A1.6 1.6 0 0 0 3.6 10" />
  </Svg>
)

export const IconCheck = (p) => (
  <Svg {...p}>
    <path d="M3 8.4 6.2 11.6 13 4.8" />
  </Svg>
)

export const IconClose = (p) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)

export const IconPlus = (p) => (
  <Svg {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Svg>
)

export const IconChevronRight = (p) => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
)

export const IconEdit = (p) => (
  <Svg {...p}>
    <path d="M8.4 3.6 3 9v4h4l5.4-5.4" />
    <path d="M10.2 1.8a1.7 1.7 0 0 1 2.4 2.4l-.9.9-2.4-2.4Z" />
  </Svg>
)

export const IconChevronUp = (p) => (
  <Svg {...p}>
    <path d="M3.5 10 8 5.5 12.5 10" />
  </Svg>
)

export const IconChevronDown = (p) => (
  <Svg {...p}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Svg>
)

// Restart rotation: counter-clockwise arrow, the "try from the top" affordance.
export const IconRefresh = (p) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5 9.2 9.2 0 0 0-6.4 2.6L3.5 8" />
    <path d="M3.5 3.5V8H8" />
  </Svg>
)

// Drag handle: six dots, the universal grip.
export const IconGrip = (p) => (
  <Svg {...p} strokeWidth="0">
    <g fill="currentColor">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </g>
  </Svg>
)

export const IconArrowLeft = (p) => (
  <Svg {...p}>
    <path d="M12.75 8H3.25M7 3.75 3.25 8 7 12.25" />
  </Svg>
)

/* ------------------------------------------------------------------- states */

export const IconWarning = (p) => (
  <Svg {...p}>
    <path d="M7.02 2.6a1.13 1.13 0 0 1 1.96 0l4.62 8.04A1.13 1.13 0 0 1 12.62 12.4H3.38a1.13 1.13 0 0 1-.98-1.76Z" />
    <path d="M8 6.1v2.7" />
    <path d="M8 10.7h.01" />
  </Svg>
)

export const IconInfo = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.4v3.3" />
    <path d="M8 5.2h.01" />
  </Svg>
)

// Providers: a stack of boxes — one per upstream.
export const IconServer = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="4" rx="1.3" />
    <rect x="2.5" y="6.5" width="11" height="4" rx="1.3" opacity="0.6" />
    <circle cx="4.6" cy="4.5" r="0.9" fill="currentColor" stroke="none" opacity="0.9" />
    <circle cx="4.6" cy="8.5" r="0.9" fill="currentColor" stroke="none" opacity="0.9" />
  </Svg>
)

// Operations / settings: three sliders.
export const IconSliders = (p) => (
  <Svg {...p}>
    <path d="M3 4.5h10M3 8h10M3 11.5h10" opacity="0.9" />
    <circle cx="6.5" cy="4.5" r="1.7" fill="var(--color-base, #fff)" />
    <circle cx="10" cy="8" r="1.7" fill="var(--color-base, #fff)" />
    <circle cx="5.5" cy="11.5" r="1.7" fill="var(--color-base, #fff)" />
  </Svg>
)

// Collapse the side rail: two vertical bars.
export const IconRail = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" opacity="0.5" />
    <path d="M6.5 2.5v11" />
  </Svg>
)

/* ---------------------------------------------------------------- modalities */

export const IconText = (p) => (
  <Svg {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
  </Svg>
)

export const IconVision = (p) => (
  <Svg {...p}>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
)

export const IconAudio = (p) => (
  <Svg {...p}>
    <path d="M2 8h1.5M5 5v6M8 2.5v11M11 5v6M14 8h-1.5" />
  </Svg>
)

// Empty pool: three stacked lanes converging — the pool motif itself.
export const IconPool = (p) => (
  <Svg {...p}>
    <path d="M2.5 4.25c3.75 0 3.75 3.75 7.5 3.75" opacity="0.45" />
    <path d="M2.5 8h7.5" />
    <path d="M2.5 11.75c3.75 0 3.75-3.75 7.5-3.75" opacity="0.45" />
    <circle cx="12" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
)

// Layers: pools share one gateway.
export const IconLayers = (p) => (
  <Svg {...p}>
    <path d="M8 2.6 14.2 5.3 8 8 1.8 5.3 8 2.6Z" />
    <path d="M1.8 8.3 8 11l6.2-2.7" opacity="0.75" />
    <path d="M1.8 11.3 8 14l6.2-2.7" opacity="0.45" />
  </Svg>
)

// No traffic yet: an open, dashed circle. Waiting, not broken.
export const IconIdle = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="1.5 2.6" opacity="0.8" />
  </Svg>
)

/* --------------------------------------------------------------------- brand */

// The Cupbearer mark: three inbound lanes merging into one outbound node.
// Same geometry as IconPool at logo scale, drawn heavier so it holds at 22px.
export function Logo({ size = 22, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <defs>
        <linearGradient id="cx-lane" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id="cx-lane-mid" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-accent-soft)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--color-accent-soft)" stopOpacity="1" />
        </linearGradient>
      </defs>
      <path
        d="M4 7 C13 7, 13 16, 22 16"
        stroke="url(#cx-lane)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M4 16 L22 16" stroke="url(#cx-lane-mid)" strokeWidth="2.4" strokeLinecap="round" />
      <path
        d="M4 25 C13 25, 13 16, 22 16"
        stroke="url(#cx-lane)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle
        cx="24.5"
        cy="16"
        r="3.6"
        fill="var(--color-accent-soft)"
        stroke="var(--color-base)"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/* ------------------------------------------------------ state icon resolver */

const STATE_ICON = {
  healthy: IconHealthy,
  degraded: IconDegraded,
  cooling: IconCooling,
  exhausted: IconDead,
  auth_failed: IconDead,
  dead: IconDead,
}

export function stateIcon(state) {
  return STATE_ICON[state] || IconUnknown
}
