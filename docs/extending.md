# Extending

"Where do I touch it" guide.

## Add a provider

Dashboard → Providers → Add (baseURL, quirks, models, keys — the model list can be fetched live via **Discover**). Or the setup wizard. Or the API:

```bash
curl -X POST http://127.0.0.1:4143/api/providers -H "content-type: application/json" -d '{
  "id": "groq", "label": "Groq", "baseURL": "https://api.groq.com/openai/v1",
  "adapter": "openai", "quirks": [],
  "keys": [{ "label": "Key 1", "value": "gsk_..." }]
}'
```

Any OpenAI-compatible upstream works — hosted APIs, local Ollama/vLLM/LM Studio, gateways.

## Add a pool (and think about tiers)

```json
{
  "id": "smart",
  "name": "Smart",
  "keyStrategy": "round-robin",
  "qualityGate": { "mode": "shadow", "threshold": 0.8 },
  "legs": [
    { "providerId": "groq", "model": "llama-3.3-70b-versatile" },
    { "providerId": "gemini", "model": "gemini-flash-latest", "tier": 1, "capabilities": ["tools"] }
  ]
}
```

- Legs without `tier`/`capabilities` route in declared order exactly as before tiers existed (default tier 2).
- `tier`: 1 flagship / 2 standard / 3 light. Requests are profiled into a required tier; the router tries the cheapest sufficient leg first. Legs weaker than required are the downgrades — the only attempts the quality gate may block.
- `capabilities`: `tools`, `vision`, `long-context`. A request needing a capability deprioritizes legs that declare themselves without it (undeclared = assumed sufficient).
- Never name a pool the same as a provider — the config rejects the collision.

## Add a quality evaluator

`server/quality/evaluators.js`. Contract:

```js
function myCheck(ctx) {
  // ctx: { payload, profile, responseText, toolCalls, sawToolCalls, finishReason }
  if (notRelevant) return { applies: false }
  return { applies: true, score: 0..1, reason: "short", hardFail: boolean }
}
```

Register it in `EVALUATORS`; pools opt in via `qualityGate.evaluators` (default: all). `hardFail` zeroes the whole verdict — reserve it for responses that are unusable by definition (broken JSON, empty, loops). Every evaluator failure is swallowed (`try/catch` in `evaluate`): a buggy check must never fail a request. Add fixtures to `server/quality/evaluators.test.js`.

## Add a provider quirk

Quirks normalize broken upstreams into clean OpenAI shapes without polluting the router — see [quirks.md](quirks.md) for the five hooks, the capture-first workflow (`probe the upstream, never guess`), and the gotchas. Register in `server/quirks/index.js`; attach per provider in config.

## Add a preset

`server/presets.js`: `{ id, label, baseURL, keyEnv, keyDocs, models (starter list), quirks?, starterTier }`. The wizard probes the key, then replaces the starter list with live discovery. Keep the starter list free-tier friendly. Note: presets never enable WAF/header shims — those exist in the quirk registry for people whose own upstream requires them, but they are opt-in by design.

## Where behaviors live

| You want to… | Touch |
|---|---|
| change failover scope/limits | `classify.js` (verdicts), `router.js` (RETRY_ON_ANOTHER_LEG, budgets) |
| change tier selection | `profile.js` (profiler bumps), `router.js` orderLegs |
| change gate behavior | `quality/gate.js` (modes/scoring), `config.js` (validation) |
| change key rotation | `router.js` orderedKeys, `health.js` (states) |
| add storage fields | `store.js` (schema), `metrics.js` (window shape) |
| dashboard panels | `ui/src/components/` (React, Tailwind 4, no router/chart deps) |

## Invariants (don't break these)

1. **Nothing writes to the client before the router commits.** Failover correctness depends on it.
2. **Key values never cross the API read path** — only `secrets.mask()` output.
3. **Config writes are atomic** (temp + rename) and validated; unknown settings are errors.
4. **Tests are hermetic** — stub `config.load`/`config.getProvider`/`secrets.has`/`upstream.*`; never depend on a machine's live config.
5. **Logging never fails a request** — store/metrics failures are swallowed by design.

## Build & develop

```bash
npm install && npm --prefix ui install
npm test && npm run smoke
npm run build        # dashboard → dist/
npm run benchmark -- --stub   # dry-run the report machinery
```
