# Quirks

OpenAI-compatible is a dialect family, not a standard. Upstreams leak `<think>` tags, stream tool calls as XML, reject valid JSON Schema, demand opaque thought signatures, and drop SSE keepalives mid-flight. **Quirks** are Cupbearer's answer: narrowly-scoped per-provider shims that normalize one upstream's dialect into clean OpenAI shapes, so the router never learns any provider's name.

## The hook interface

A quirk is a module exporting an `id`, a `description`, and any subset of:

```js
transformRequest(body, ctx)        // mutate the outbound JSON
transformHeaders(headers, ctx)     // mutate outbound headers
transformResponse(payload, ctx)    // rewrite a non-streaming body
filterStreamLine(line, ctx)        // return false to drop an SSE line
createStreamTranslator(ctx)        // stateful stream rewriter (at most ONE per provider)
```

`ctx` carries `{ provider, model, stream, tools }`. The registry (`server/quirks/index.js`) composes a provider's list in declared order and surfaces configuration errors loudly (two translators on one provider is a config error, not a coin flip).

## Catalog

| Quirk | Fixes | Hooks |
|---|---|---|
| `aistudio-schema` | strict upstream schema encoders: rejected JSON-Schema keywords, non-string enums, single-branch unions crashing on `items`, `$ref` dereferencing | request |
| `aistudio-think-sig` | Gemini 3.x thought signatures: caches the per-call signature, re-injects it onto assistant `tool_calls` (and function names onto tool results) so multi-turn tool chains pass | request/response/filter |
| `aistudio-multipart` | image/multipart upload shims for strict gateways | request |
| `nvidia-nim` | `tools` on vision requests hard-400ing Llama vision models; omni models burning their budget thinking | request |
| `openrouter` | reasoning-token budget burn; keepalive SSE lines committing headers early | request/filter |
| `qwen-xml` | function calls streamed as plaintext XML (`<tool_call>…`) → structured `tool_calls` deltas + correct `finish_reason` (positional lookahead, never naive regex) | translator |
| `think-tags` | paired `<think>…</think>` leaking into visible content → `reasoning_content`, handles tags split across chunks | translator |
| `deepseek-tools` | unterminated `<think>`, sentinel tokens, duplicated tool calls, output-cap truncation → `truncated_tool_call` verdict | translator |
| `sse-null` | `data: null` keepalives | filter |
| `waf-headers` | browser-like headers for gateways that front themselves with a WAF. **Deliberately opt-in and undocumented in the marketing material**: it exists for people whose own upstream requires it, and presets never enable it | headers |

## The stream translator contract

A translator owns the stream: it receives content deltas (`push`), optionally takes ownership of native tool-call deltas (`pushToolCalls` — required when an upstream interleaves prose with argument fragments, since those can only be judged at end of stream), and returns its final output from `finish()`:

```js
{ fragments: [{ text } | { reasoning }], toolCalls: [...], error: { message, cupbearerVerdict? } }
```

Two rules make failover compose with translation:

- **Deferred commit**: headers are written at the first flushed byte. A translator that buffers tool calls may reject the response at `finish()` with nothing written — the router then fails over normally.
- **The error verdict**: `finish()` errors may carry a `cupbearerVerdict` (`{ reason, keyState, scope }`) which the router prefers over generic `stream_failed`, so health and the dashboard record the real cause and scope.

## Writing a new quirk

1. **Capture the raw upstream bytes.** Never guess: point a minimal fetch at the upstream with its own key and save the verbatim stream/JSON as the test fixture.
2. Write `server/quirks/<name>.js` against the hook interface.
3. Write `server/quirks/<name>.test.js` with those verbatim payloads as fixtures — the existing quirk tests are all real captured traffic.
4. Register in `server/quirks/index.js`; attach per provider in config (`"quirks": ["<name>"]`); the API rejects unknown ids at write time.
5. `npm test` — quirk tests run like everything else, hermetically.

## The quality gate's relationship to quirks

Evaluators (`server/quality/evaluators.js`) judge the *normalized* output after quirks ran — so a quirk that repairs an upstream's broken tool-call stream also improves its gate scores. A quirk's `truncated_tool_call` verdict is request-scoped (a deterministic output cap will reproduce on every leg), while quality-gate failures are leg-scoped (another key on the same model fails identically; a stronger leg may not).
