# DESIGN.md — UI research & the "Tasting Room" proposal

**Status: proposal — awaiting vibe-check before any rebuild.** The current dashboard is the ported Conflux skin. This doc records why that fails for Cupbearer, what research says wins in 2026, and the concrete direction proposed.

---

## 1. Diagnosis — why the current UI doesn't fit

- **It's literally Conflux's interface.** Indigo-on-near-black admin console: Pools / Providers / Operations. Competent, but it says "generic SaaS panel" — nothing about the name, the story, or the edge.
- **Config-first, story-last.** The product's soul — "this answer was NOT good enough, so the client never saw it" — is one tab deep, behind a concept (quality gate) the user has to already understand.
- **Settings shock.** Operations exposes ~17 knobs on one page. For a tool whose promise is "set it up in 5 minutes", that reads as complexity tax.
- **No first-run moment.** After setup, the dashboard is empty tables. The edge is invisible exactly when the user is most curious. Someone who adds ONE key sees… Conflux.
- **Zero memorability.** Nothing to screenshot. Launch lives or dies on a visual.

## 2. What research says wins (2026)

- The **Linear / Stripe / Mercury school**: one dense, restrained, live feed beats pages of charts; dark-first; micro-interactions reserved for controls ([AdminLTE 2026 roundup](https://adminlte.io/blog/saas-dashboard-design-examples/), [Muzli examples](https://muz.li/blog/best-dashboard-design-examples-inspirations-for-2026/)).
- **Observability's dual mandate** — operational visibility *and* cost/quality — is exactly our frame; the tools that win show decisions and "why", not just metrics ([Platform Engineering, 2026](https://platformengineering.org/blog/10-observability-tools-platform-engineers-should-evaluate-in-2026)).
- **Agent-UI trust pattern**: transparency + override — show what the system decided and let the user inspect it ([Fuselab, Agent UX](https://fuselabcreative.com/ui-design-for-ai-agents/)); audit-style "home base" surfaces beat buried settings ([layout patterns](https://medium.com/@claus.nisslmueller/where-should-ai-agents-live-in-your-ui-cd27965a577a)).
- **The open lane**: Langfuse/LangSmith/Helicone-class tools trace *after* the fact, for debugging. **Nobody shows pre-serve verification** — a response being judged and blocked before the client sees it. That's our unclaimed visual moment ([agentic observability context](https://www.dash0.com/knowledge/what-is-agentic-observability)).
- Trend scans agree 2026 dashboards shift from static reporting to systems that *tell you what happened and why* ([Fuselab 2026](https://fuselabcreative.com/top-dashboard-design-trends-2025/), [Tubik](https://tubikstudio.com/blog/ui-design-trends-2026/)).

## 3. The direction — "The Tasting Room"

The Cupbearer tasted the cup before the king drank. The UI should *be* that: a live room where every request gets tasted, and every verdict gets sealed.

### Information architecture: 3 surfaces + a drawer

| Surface | What it is |
|---|---|
| **Stream** (default) | The product, live. One SSE-driven feed; each row is a request's story left-to-right: `who → task badge (tier) → leg served → VERDICT SEAL → latency/tokens`. Click a row → the tasting card: evaluator breakdown chips, judge note, and what got served instead when a downgrade was blocked. |
| **Pools** | Pools + Providers merged. One-key-first onboarding: the empty state *is* the demo — paste one key, watch it probe, then "run a test request" fires a built-in ping and animates your first verdict seal. The edge visible inside 60 seconds. |
| **Evidence** | Quality + benchmark merged: quality-hold %, blocked-and-rerouted counts, top failure reasons, one-click benchmark run and the rendered report. |
| Settings | A drawer from anywhere, not a page. 5 settings surfaced, the rest behind "advanced", each with a plain-sentence tooltip. |

### The signature element: the Seal

Every verified response gets a **wax-seal verdict** — pressed-stamp animation, brass on dark: `TASTED · HELD` (emerald), `BLOCKED · REROUTED` (oxblood). The metaphor rendered literally: the taster drank first, and the seal proves it. It's the landing-page GIF, the screenshot everyone takes, and it exists nowhere else in the LLM-tooling space.

### Palette & type (drop the indigo clone)

- Base: warm near-black charcoal (`#141210` family), parchment-warm neutrals for text — vault/assay-office, not neon SaaS.
- Accent: **brass/gold** (`#C9A227` family) for seals, the wordmark, primary actions.
- Verdicts: emerald = held, oxblood = blocked; amber = shadow-fail (evidence only).
- Type: keep the mono for data; add a characterful display serif (Fraunces or Instrument Serif) for the wordmark and headings — craft-meets-terminal.
- Motion: seals stamp once (respecting `prefers-reduced-motion`); the stream tail-glow only while traffic flows.

### Small backend enabler

Stream rows need the request's profile (tier, capabilities) and gate outcome in one event. Today `success/failure` events carry routing info and `gate` events carry scores — extend them with `requiredTier`/`servedTier`/`score` so the Stream renders the full story without a second fetch. ~20 lines in `router.js` + `events`.

## 4. Plain-words: how downgrading actually works (the product copy this UI must make obvious)

- **One key?** Nothing ever downgrades — there's nowhere to go. Cupbearer behaves like any single-provider gateway; the gate idles. The edge needs at least two legs.
- **The intended setup** (what `setup` builds): cheap leg first, stronger backup second, gate `shadow` → `gate` once evidence convinces you. Easy requests: served by the cheap leg, untouched. Hard requests: cheap leg's answer gets tasted; pass → served; fail → the client never sees it, the stronger leg answers.
- **"I want THIS provider for THIS model, no auto anything"**: call `providerId/model` (e.g. `groq/llama-3.3-70b-versatile`). That's a pinned direct route — no pool, no downgrades, no gate. Always available, zero config.
- **The knobs, honestly**: gate mode + threshold are per-pool; tiers/capabilities per leg; `defaultQualityMode` is the global fallback. That's the whole surface — 4 concepts, which is what the UI should feel like too.

## 5. Build order (after vibe-check)

1. Tokens + shell: new palette, serif wordmark, drawer-style settings (keep all components working).
2. Stream page with seal verdicts (backend event extension included).
3. Pools page with the one-key empty-state demo.
4. Evidence page (absorb Quality + benchmark view).
5. Delete the old Operations page; move surfaced settings into the drawer.
