"use strict"

// The fixtures are the real tool schemas that produced 400s from the local AI
// Studio gateway (ZCode's AskUserQuestion, the incogniton MCP tools), plus a
// `mimicEncoder` that reimplements every validation in AIStudio2API's
// internal/aistudio/schema.go. Asserting against the mimic rather than only the
// observed messages is what stops this quirk from being fixed one 400 at a time.

const { test } = require("node:test")
const assert = require("node:assert")
const quirk = require("./aistudio-schema")
const { sanitize, ALLOWED } = quirk._internals

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"])
const INT_FIELDS = ["minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength"]
const NUM_FIELDS = ["minimum", "maximum"]
const STR_FIELDS = ["format", "description", "pattern"]
const STRLIST_FIELDS = ["enum", "required", "propertyOrdering"]

// Every rejection path in schema.go, as a list of complaints. Empty means the
// real encoder would accept the schema.
function mimicEncoder(node, path = "$", out = []) {
  if (!node || typeof node !== "object") {
    out.push(`${path}: schema 必须是 JSON object`)
    return out
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) out.push(`${path}: JSON schema 字段 ${key}`)
  }

  // schemaType: a string type, or one borrowed from a variant.
  let type = node.type
  if (Array.isArray(type)) type = type.filter((t) => t !== "null")[0]
  if (typeof type !== "string" || !type) {
    for (const k of ["anyOf", "oneOf", "allOf"]) {
      const v = Array.isArray(node[k]) && node[k].find((x) => x && typeof x.type === "string")
      if (v) {
        type = v.type
        break
      }
    }
  }
  if (typeof type !== "string" || !type) out.push(`${path}: schema.type 必须是字符串`)
  else if (!TYPES.has(type)) out.push(`${path}: 未知 schema.type ${type}`)

  for (const k of STRLIST_FIELDS) {
    if (node[k] !== undefined && !(Array.isArray(node[k]) && node[k].every((x) => typeof x === "string"))) {
      out.push(`${path}: schema.${k} 必须是字符串数组`)
    }
  }
  for (const k of INT_FIELDS) {
    if (node[k] !== undefined && !(Number.isInteger(node[k]) && node[k] >= 0)) {
      out.push(`${path}: schema.${k} 必须是非负整数`)
    }
  }
  for (const k of NUM_FIELDS) {
    if (node[k] !== undefined && !(typeof node[k] === "number" && Number.isFinite(node[k]))) {
      out.push(`${path}: schema.${k} 必须是数字`)
    }
  }
  for (const k of STR_FIELDS) {
    if (node[k] !== undefined && typeof node[k] !== "string") {
      out.push(`${path}: schema.${k} 必须是字符串`)
    }
  }
  if (node.nullable !== undefined && typeof node.nullable !== "boolean") {
    out.push(`${path}: schema.nullable 必须是布尔值`)
  }

  if (node.properties !== undefined) {
    if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) {
      out.push(`${path}: schema.properties 必须是 JSON object`)
    } else {
      for (const [n, sub] of Object.entries(node.properties)) mimicEncoder(sub, `${path}.properties.${n}`, out)
    }
  }
  if (node.items !== undefined) mimicEncoder(node.items, `${path}.items`, out)
  if (node.not !== undefined) mimicEncoder(node.not, `${path}.not`, out)
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[k])) node[k].forEach((v, i) => mimicEncoder(v, `${path}.${k}[${i}]`, out))
  }
  return out
}

function clean(schema) {
  const defs = schema.$defs || schema.definitions || null
  return sanitize(JSON.parse(JSON.stringify(schema)), defs)
}

// ---------------------------------------------------------------- fixtures ---

// ZCode AskUserQuestion. `annotations` and `answers` are open string maps typed
// with propertyNames, which is what produced the first 400.
const ASK_USER_QUESTION = {
  type: "object",
  properties: {
    annotations: { type: "object", description: "Optional per-question annotations", propertyNames: { type: "string" } },
    answers: { type: "object", description: "User answers", propertyNames: { type: "string" } },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        required: ["question", "header", "options", "multiSelect"],
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          multiSelect: { default: false, type: "boolean" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              required: ["label", "description"],
              properties: { label: { type: "string" }, description: { type: "string" } },
            },
          },
        },
      },
    },
  },
  required: ["questions"],
}

// incogniton create_profiles. Numeric enums everywhere; audio_inputs is the one
// named in the second 400.
const CREATE_PROFILES = {
  type: "object",
  properties: {
    profile_names: { type: "array", items: { type: "string" } },
    audio_inputs: { description: "Number of microphones.", enum: [1, 2, 3, 4], type: "integer" },
    audio_outputs: { enum: [1, 2, 3, 4], type: "integer" },
    video_outputs: { enum: [1, 2, 3, 4], type: "integer" },
    navigator_donotrack: { default: 0, description: "0 = disabled, 1 = enabled.", enum: [0, 1], type: "integer" },
    navigator_languageIPToggle: { default: 1, enum: [0, 1], type: "integer" },
    active_session_lock: { default: "true", enum: ["true", "false"], type: "string" },
    canvas_fingerprintEnabled: { default: "Off", enum: ["Noise", "Off", "Block"], type: "string" },
    custom_proxy: {
      type: "object",
      properties: {
        connection_type: { default: "HTTP Proxy", enum: ["HTTP Proxy", "Socks 4 Proxy"], type: "string" },
        proxy_rotating: { default: 0, enum: [0, 1], type: "integer" },
      },
    },
  },
  required: ["profile_names"],
}

// CronCreate delayMinutes: a oneOf whose second branch is a bare null type.
const CRON_CREATE = {
  type: "object",
  properties: {
    delayMinutes: {
      description: "Positive delay in whole minutes.",
      oneOf: [{ exclusiveMinimum: 0, maximum: 525600, type: "integer" }, { type: "null" }],
    },
    title: { minLength: 1, type: "string" },
    recurring: { type: "boolean" },
  },
  required: ["prompt", "title"],
}

// Nothing real, just every remaining way to violate the encoder at once.
const HOSTILE = {
  type: "object",
  $defs: { Named: { type: "object", properties: { q: { type: "string" }, deep: { type: "object", propertyNames: { type: "string" } } } } },
  properties: {
    ref: { $ref: "#/$defs/Named" },
    mode: { const: "single" },
    numConst: { const: 7 },
    titled: { type: "string", title: "Nice Name" },
    exampled: { type: "string", examples: ["a", "b"] },
    tuple: { prefixItems: [{ type: "string" }, { type: "number" }] },
    untyped: { description: "no type at all" },
    nullOnly: { type: "null" },
    union: { type: ["string", "null"] },
    floatLen: { type: "string", maxLength: 10.7 },
    negLen: { type: "string", minLength: -5 },
    strMin: { type: "number", minimum: "3" },
    badDesc: { type: "string", description: 42 },
    badNullable: { type: "string", nullable: "yes" },
    mixedEnum: { type: "string", enum: ["a", 2, null] },
    patterned: { patternProperties: { "^x": { type: "string" } } },
    multiple: { type: "integer", multipleOf: 3, exclusiveMaximum: 9 },
    uniq: { type: "array", uniqueItems: true, items: { type: "string" } },
    conditional: { type: "object", if: { type: "object" }, then: { type: "object" }, readOnly: true },
  },
}

// Real tool schemas from ZCode's computer-use MCP server, captured byte-for-byte
// from the failing request bodies. `region`/`text_range`/`capabilities` are
// nullable arrays whose anyOf carries a {type:"null"} branch. AI Studio's
// encoder cannot represent ANY array-with-items inside a union ("missing
// field"), so a surviving single branch must collapse to the plain schema.
const COMPUTER_USE = {
  type: "object",
  properties: {
    region: {
      description: "Crop bounds [x0,y0,x1,y1]",
      anyOf: [
        { minItems: 4, maxItems: 4, type: "array", items: { type: "integer" } },
        { type: "null" },
      ],
    },
    text_range: {
      anyOf: [
        { minItems: 2, maxItems: 2, type: "array", items: { type: "integer" } },
        { type: "null" },
      ],
    },
    capabilities: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    },
    target: {
      anyOf: [
        { type: "object", properties: { type: { const: "element" } } },
        { type: "object", properties: { type: { const: "coordinate" } } },
      ],
    },
  },
}

// ------------------------------------------------------------------ tests ---

test("the fixtures really would be rejected before sanitising", () => {
  // Guards the guard: if AIStudio2API ever relaxes its encoder these fixtures
  // stop proving anything, and this test says so.
  assert.ok(mimicEncoder(ASK_USER_QUESTION).some((c) => c.includes("propertyNames")))
  assert.ok(mimicEncoder(CREATE_PROFILES).some((c) => c.includes("schema.enum 必须是字符串数组")))
  assert.ok(mimicEncoder(HOSTILE).length > 10)
})

for (const [name, schema] of [
  ["AskUserQuestion", ASK_USER_QUESTION],
  ["create_profiles", CREATE_PROFILES],
  ["CronCreate", CRON_CREATE],
  ["hostile", HOSTILE],
  ["computer-use", COMPUTER_USE],
]) {
  test(`${name} survives the encoder after sanitising`, () => {
    assert.deepEqual(mimicEncoder(clean(schema)), [])
  })
}

test("propertyNames is dropped but the description survives", () => {
  const s = clean(ASK_USER_QUESTION)
  assert.deepEqual(s.properties.annotations, {
    type: "object",
    description: "Optional per-question annotations",
  })
})

test("a numeric enum becomes prose and the integer type is left alone", () => {
  const p = clean(CREATE_PROFILES).properties
  assert.equal(p.audio_inputs.type, "integer")
  assert.equal(p.audio_inputs.enum, undefined)
  assert.equal(p.audio_inputs.description, "Number of microphones. Allowed values: 1, 2, 3, 4.")
  assert.equal(p.custom_proxy.properties.proxy_rotating.enum, undefined)
  assert.match(p.custom_proxy.properties.proxy_rotating.description, /Allowed values: 0, 1\./)
})

test("a string enum is passed through untouched", () => {
  const p = clean(CREATE_PROFILES).properties
  assert.deepEqual(p.canvas_fingerprintEnabled.enum, ["Noise", "Off", "Block"])
  assert.deepEqual(p.custom_proxy.properties.connection_type.enum, ["HTTP Proxy", "Socks 4 Proxy"])
})

test("required stays intact", () => {
  assert.deepEqual(clean(ASK_USER_QUESTION).required, ["questions"])
  assert.deepEqual(clean(CREATE_PROFILES).required, ["profile_names"])
})

test("lossless rewrites keep their meaning", () => {
  const p = clean(HOSTILE).properties
  assert.deepEqual(p.mode.enum, ["single"])
  assert.match(p.numConst.description, /Allowed values: 7\./)
  assert.equal(p.titled.description, "Nice Name")
  assert.equal(p.exampled.example, "a")
  assert.deepEqual(p.tuple, { items: { type: "string" }, type: "array" })
  assert.deepEqual(p.ref.properties.q, { type: "string" })
  assert.deepEqual(p.ref.properties.deep, { type: "object" })
})

test("malformed keyword values are dropped rather than passed on", () => {
  const p = clean(HOSTILE).properties
  assert.equal(p.negLen.minLength, undefined)
  assert.equal(p.floatLen.maxLength, 11) // rounded, not dropped
  assert.equal(p.strMin.minimum, undefined)
  assert.equal(p.badDesc.description, undefined)
  assert.equal(p.badNullable.nullable, undefined)
  assert.equal(p.mixedEnum.enum, undefined)
  assert.match(p.mixedEnum.description, /Allowed values: "a", 2, null\./)
})

test("every node ends up with a type the encoder knows", () => {
  const p = clean(HOSTILE).properties
  assert.equal(p.untyped.type, "string")
  assert.equal(p.patterned.type, "object")
  assert.equal(p.uniq.type, "array")
  assert.equal(p.nullOnly.type, "string") // a bare null type is not representable
  assert.deepEqual(p.union.type, ["string", "null"]) // union kept; Go maps it to nullable
})

test("computer-use nullable arrays: single-branch unions collapse, null becomes nullable", () => {
  const p = clean(COMPUTER_USE).properties
  // The encoder cannot put an array-with-items inside anyOf, so the surviving
  // branch must be the schema itself (this was the "…items: missing field" 400).
  assert.deepEqual(p.region, {
    description: "Crop bounds [x0,y0,x1,y1]",
    nullable: true,
    minItems: 4,
    maxItems: 4,
    type: "array",
    items: { type: "integer" },
  })
  assert.deepEqual(p.text_range, {
    nullable: true,
    minItems: 2,
    maxItems: 2,
    type: "array",
    items: { type: "integer" },
  })
  assert.deepEqual(p.capabilities, { nullable: true, type: "array", items: { type: "string" } })
  // A genuine two-branch union stays a union.
  assert.deepEqual(p.target.anyOf.length, 2)
  assert.equal(p.target.type, undefined)
})

test("transformRequest rewrites tools and response_format, leaving the rest alone", () => {
  const body = {
    model: "gemini-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "create_profiles", parameters: CREATE_PROFILES } }],
    response_format: { type: "json_schema", json_schema: { name: "r", schema: ASK_USER_QUESTION } },
  }
  const out = quirk.transformRequest(JSON.parse(JSON.stringify(body)))
  assert.deepEqual(mimicEncoder(out.tools[0].function.parameters), [])
  assert.deepEqual(mimicEncoder(out.response_format.json_schema.schema), [])
  assert.equal(out.tools[0].function.name, "create_profiles")
  assert.deepEqual(out.messages, body.messages)
  assert.equal(out.model, "gemini-flash")
})

test("a request with no tools is returned unchanged", () => {
  const body = { model: "gemini-flash", messages: [{ role: "user", content: "hi" }] }
  assert.deepEqual(quirk.transformRequest(body), body)
})

test("a tool with no parameters is left as-is", () => {
  const body = { tools: [{ type: "function", function: { name: "noargs" } }] }
  assert.deepEqual(quirk.transformRequest(body).tools[0], body.tools[0])
})

