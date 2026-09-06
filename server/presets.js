"use strict"
// DOC: ../docs/extending.md → § Provider presets
//
// Built-in provider presets for the setup wizard. Every preset is BYOK: the
// user's own key, entered locally, stored in secrets.json, never transmitted
// anywhere except to that provider's official API endpoint.
//
// `models` are known-good *starter* models (free-tier friendly), not a catalog —
// the wizard offers to replace them with the provider's live /v1/models via
// model discovery right after the key is verified. Model ids drift; discovery
// is the source of truth.

const PRESETS = {
  groq: {
    id: "groq",
    label: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    keyDocs: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    starterTier: 2,
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini (AI Studio API)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    keyDocs: "https://aistudio.google.com/apikey",
    models: ["gemini-flash-latest", "gemini-flash-lite-latest"],
    starterTier: 1,
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    keyDocs: "https://cloud.cerebras.ai",
    models: ["llama-3.3-70b", "llama3.1-8b"],
    starterTier: 2,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    keyDocs: "https://console.mistral.ai/api-keys",
    models: ["mistral-small-latest", "open-mistral-nemo"],
    starterTier: 2,
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseURL: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    keyDocs: "https://build.nvidia.com",
    quirks: ["nvidia-nim"],
    models: ["meta/llama-3.3-70b-instruct", "meta/llama-3.1-8b-instruct"],
    starterTier: 2,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    keyDocs: "https://openrouter.ai/settings/keys",
    quirks: ["openrouter"],
    models: ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-r1:free"],
    starterTier: 2,
  },
}

// Cheapest-first starter order for the demo pool: presets earlier in the list
// are tried first, stronger ones back them up.
const STARTER_ORDER = ["groq", "cerebras", "mistral", "nvidia", "openrouter", "gemini"]

function list() {
  return Object.values(PRESETS)
}

function get(id) {
  return PRESETS[id] || null
}

module.exports = { PRESETS, STARTER_ORDER, list, get }
