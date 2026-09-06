"use strict"
// DOC: ../../docs/quirks.md → § The quirk interface

// Quirk: aistudio-schema
//
// For the `aistudio` provider (local AIStudio2API on 127.0.0.1:2048, which
// speaks Google AI Studio's private MakerSuite RPC protocol).
//
// AI Studio does not take JSON Schema. It takes a positional protobuf-as-JSON
// array, and AIStudio2API encodes tool parameters into it field by field. That
// encoder carries a hard allow-list of schema keywords and refuses anything it
// has not confirmed on the wire: internal/aistudio/schema.go:28-41 returns
// UnverifiedProtocolError for any key outside the list. Observed verbatim from
// ZCode against gemini-flash:
//
//   AI Studio 请求参数无效: 编码 function declaration 1: parameters:
//   schema.properties.annotations: AI Studio 协议能力尚无成功现场证据:
//   JSON schema 字段 propertyNames
//
// Function declaration 1 is ZCode's AskUserQuestion, whose `annotations`
// property is an open string map typed with `propertyNames`. The result is a
// non-retryable 400, so the turn dies instead of failing over to the next leg —
// and since every ZCode request carries the same tool array, it dies on every
// request, not only the ones that would call that tool.
//
// So: reduce tool schemas to the keywords the encoder admits, keeping meaning
// wherever a lossless rewrite exists (`const` becomes a single-value `enum`,
// `examples` becomes `example`, `title` folds into `description`, `prefixItems`
// collapses to `items`) and dropping the remainder, which are validation hints
// the model does not need. Also give every node an explicit `type`: schemaType()
// at schema.go:286-310 hard-errors on a node without one, while JSON Schema
// itself treats it as optional.
//
// response_format's json_schema goes through the same encoder, so it gets the
// same treatment.
//
// The allow-list is only half of it: the encoder is also strict about the *type*
// of each keyword's value, and violations are the same non-retryable 400. Second
// observation, from the incogniton MCP tools:
//
//   AI Studio 请求参数无效: 编码 function declaration 49: parameters:
//   schema.properties.audio_inputs: schema.enum 必须是字符串数组
//
// That property is `{ type: "integer", enum: [1, 2, 3, 4] }`. AI Studio's schema
// message types `enum` as repeated string (schema.go:73-79 unmarshals into
// []string), so a numeric enum cannot be represented at all — and numeric enums
// are all over those tools. Stringifying them would be wrong, because the field
// is still an integer and the model would start quoting its arguments. Instead
// the enum is dropped and its values are appended to the description, which
// keeps the type honest and still tells the model the valid set.
//
// So rather than fix keywords one 400 at a time, every keyword is checked
// against what its encoder helper will actually accept: schemaString for
// format/description/pattern, schemaStrings for enum/required/propertyOrdering,
// schemaInteger (non-negative, no floats) for the min/max length and count
// fields, schemaNumber for minimum/maximum, and a bool for nullable. Anything
// that would not survive is repaired if possible and dropped if not.


// Verbatim from internal/aistudio/schema.go:28-36.
const ALLOWED = new Set([
  "type", "format", "description", "nullable",
  "enum", "items", "properties", "required",
  "minItems", "maxItems", "minProperties", "maxProperties",
  "minimum", "maximum", "minLength", "maxLength",
  "pattern", "example", "oneOf", "anyOf",
  "allOf", "not", "propertyOrdering",
  "$schema", "additionalProperties", "default", "exclusiveMinimum",
])

const VARIANTS = ["oneOf", "anyOf", "allOf"]

// schemaTypeCodes at schema.go:11-18 — anything else is "未知 schema.type".
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"])

// schemaInteger: parsed with ParseInt and rejected when negative.
const INT_FIELDS = new Set([
  "minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength",
])
// schemaNumber: parsed with ParseFloat.
const NUM_FIELDS = new Set(["minimum", "maximum"])
// schemaString: must unmarshal into a Go string.
const STR_FIELDS = new Set(["format", "description", "pattern"])
// schemaStrings: must unmarshal into []string.
const STRLIST_FIELDS = new Set(["enum", "required", "propertyOrdering"])
// Allowed but never read by the encoder, so any value is harmless.
const IGNORED_FIELDS = new Set(["$schema", "additionalProperties", "default", "exclusiveMinimum", "example"])

function jsonType(value) {
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (Array.isArray(value)) return "array"
  if (value && typeof value === "object") return "object"
  return "string"
}

function allStrings(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
}

function finiteNumber(v) {
  return typeof v === "number" && Number.isFinite(v)
}

function deref(ref, defs) {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
  return m && defs ? defs[m[1]] || null : null
}

// schemaType() tolerates a missing `type` only when a variant supplies one.
function inferType(node, out) {
  if (VARIANTS.some((k) => Array.isArray(out[k]) && out[k].some((v) => v && v.type))) return null
  if (out.properties || node.patternProperties || node.propertyNames) return "object"
  if (out.items) return "array"
  if (allStrings(out.enum)) return "string"
  if (Array.isArray(node.enum) && node.enum.length) return jsonType(node.enum[0])
  if (node.const !== undefined) return jsonType(node.const)
  return "string"
}

// A `type` the encoder understands, or undefined to let inference decide.
function normalizeType(value) {
  if (Array.isArray(value)) {
    const kept = value.filter((t) => typeof t === "string" && (TYPES.has(t) || t === "null"))
    const real = kept.filter((t) => t !== "null")
    if (!real.length) return undefined
    return kept.length > 1 ? kept : real[0]
  }
  if (typeof value === "string" && TYPES.has(value)) return value
  return undefined
}


function sanitize(node, defs) {
  if (Array.isArray(node)) return node.map((n) => sanitize(n, defs))
  if (!node || typeof node !== "object") return node

  // Resolve a local $ref first; dropping it unresolved would leave an empty node.
  if (typeof node.$ref === "string") {
    const target = deref(node.$ref, defs)
    if (target) {
      const merged = { ...target }
      for (const [k, v] of Object.entries(node)) if (k !== "$ref") merged[k] = v
      return sanitize(merged, defs)
    }
  }

  const out = {}
  const notes = []
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object") {
      out.properties = {}
      for (const [name, sub] of Object.entries(value)) out.properties[name] = sanitize(sub, defs)
    } else if (key === "items" || key === "not") {
      out[key] = sanitize(value, defs)
    } else if (VARIANTS.includes(key) && Array.isArray(value)) {
      // Union handling mirrors the encoder's own normalizeNullableVariants:
      //  - a `{type:"null"}` branch means nullable, not a type — drop it and
      //    mark the node nullable (schema.go:241-282)
      //  - z.unknown()/z.any() become {} in some converters; schemaType() walks
      //    variants looking for a type and a variant without one is a hard 400
      //    ("missing field"). Sanitising adds a default type, which would make
      //    an empty variant look valid and survive; drop any variant that did
      //    not declare a type of its own.
      let sawNull = false
      const cleaned = []
      for (const v of value) {
        if (v && typeof v === "object" && v.type === "null") {
          sawNull = true
          continue
        }
        const s = sanitize(v, defs)
        const declaredType = v && typeof v === "object" && typeof v.type === "string"
        if (!declaredType) continue
        cleaned.push(s)
      }
      if (sawNull) out.nullable = true
      if (cleaned.length === 1) {
        // A single surviving branch: collapse the union away. The encoder
        // cannot represent an array-with-items (or any items-bearing schema)
        // inside anyOf/oneOf — observed as "…items: missing field" 400s — so a
        // bare single-variant union must become the plain schema itself.
        const [only] = cleaned
        for (const [k2, v2] of Object.entries(only)) out[k2] = v2
      } else if (cleaned.length > 1) {
        out[key] = cleaned
      }
    } else if (key === "type") {
      const t = normalizeType(value)
      if (t !== undefined) out.type = t
    } else if (STRLIST_FIELDS.has(key)) {
      // enum/required/propertyOrdering must be []string or the encoder 400s.
      if (allStrings(value)) {
        out[key] = value
      } else if (key === "enum" && Array.isArray(value) && value.length) {
        // A numeric or mixed enum has no wire representation. Keep the
        // information as prose instead of lying about the field's type.
        notes.push(`Allowed values: ${value.map((v) => JSON.stringify(v)).join(", ")}.`)
      }
    } else if (INT_FIELDS.has(key)) {
      if (finiteNumber(value) && value >= 0) out[key] = Math.round(value)
    } else if (NUM_FIELDS.has(key)) {
      if (finiteNumber(value)) out[key] = value
    } else if (STR_FIELDS.has(key)) {
      if (typeof value === "string") out[key] = value
    } else if (key === "nullable") {
      if (typeof value === "boolean") out.nullable = value
    } else if (IGNORED_FIELDS.has(key)) {
      out[key] = value
    } else if (key === "const") {
      if (typeof value === "string") out.enum = [value]
      else notes.push(`Allowed values: ${JSON.stringify(value)}.`)
    } else if (key === "examples" && Array.isArray(value) && value.length) {
      out.example = value[0]
    } else if (key === "title" && typeof value === "string" && !node.description) {
      out.description = value
    } else if (key === "prefixItems" && Array.isArray(value) && value.length) {
      out.items = sanitize(value[0], defs)
    }
    // Everything else — propertyNames, $defs, patternProperties, multipleOf,
    // uniqueItems, if/then/else, exclusiveMaximum, unevaluated*, readOnly … —
    // is a constraint the encoder rejects and the model can do without.
  }

  if (notes.length) {
    out.description = [out.description, ...notes].filter(Boolean).join(" ")
  }
  if (out.type === undefined) {
    // schemaType() at schema.go:286 also borrows a type from the first variant
    // that declares one; mirror that so inference does not fight the encoder.
    const inferred = inferType(node, out)
    if (inferred) out.type = inferred
  }
  return out
}

module.exports = {
  id: "aistudio-schema",
  description:
    "For the local AI Studio gateway: reduces tool and response_format JSON Schemas to the keyword set its protobuf encoder accepts — propertyNames, $defs, const, multipleOf and friends are otherwise a non-retryable 400 that kills every request — and gives every schema node an explicit type.",

  transformRequest(body) {
    let out = body

    if (Array.isArray(body && body.tools) && body.tools.length) {
      const tools = body.tools.map((tool) => {
        const params = tool && tool.function && tool.function.parameters
        if (!params || typeof params !== "object") return tool
        const defs = params.$defs || params.definitions || null
        return { ...tool, function: { ...tool.function, parameters: sanitize(params, defs) } }
      })
      out = { ...out, tools }
    }

    const js = body && body.response_format && body.response_format.json_schema
    if (js && js.schema && typeof js.schema === "object") {
      const defs = js.schema.$defs || js.schema.definitions || null
      out = {
        ...out,
        response_format: {
          ...body.response_format,
          json_schema: { ...js, schema: sanitize(js.schema, defs) },
        },
      }
    }

    return out
  },

  _internals: { sanitize, ALLOWED },
}

