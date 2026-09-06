"use strict"
// DOC: ../../docs/quirks.md → § sse-null

// Quirk: sse-null
//
// Some gateways inject a literal `data: null` line into SSE streams, which
// breaks @ai-sdk/openai-compatible with "Type validation failed: Value: null".
// This was the entire reason the old agentrouter-proxy.js existed.
//
// Phase 0 note: 41 stream events from agentrouter on glm-5.3 contained zero
// `data: null` lines, so the upstream may have fixed it — but the Claude models
// that originally exhibited it were unreachable (402/503) at probe time, so this
// stays available as opt-in insurance. Filtering costs one string comparison per
// line, and a false negative here is a hard stream failure.

module.exports = {
  id: "sse-null",
  description: 'Drops literal "data: null" SSE lines that break strict OpenAI stream parsers.',

  // Returning false from a line filter drops the line.
  filterStreamLine(line) {
    return line.trim() !== "data: null"
  },
}
