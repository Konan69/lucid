/** Ported from opencode `packages/codemode/src/tool-schema.ts` at 3884062 (MIT). */
import { Cause, Effect, JsonPointer, Result, Schema } from 'effect'
import type { Definition, JsonSchema, SchemaType } from './tool.ts'

const isEffectSchema = (schema: SchemaType): schema is Schema.Decoder<unknown> & Schema.Top =>
  Schema.isSchema(schema)

const renderLiteral = (value: unknown): string => JSON.stringify(value) ?? 'unknown'

/**
 * Bare TypeScript identifier - usable unquoted as an object key (and, in the tool runtime,
 * with dot access as a tool-path segment). Anything else must be quoted/bracketed.
 */
export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Renders a property name as a valid TS object key: bare when an identifier, quoted otherwise. */
const renderKey = (name: string): string =>
  identifierSegment.test(name) ? name : JSON.stringify(name)

const effectNumberSentinel = (schema: JsonSchema) =>
  schema.type === 'string' &&
  Array.isArray(schema.enum) &&
  schema.enum.length === 1 &&
  (schema.enum[0] === 'NaN' || schema.enum[0] === 'Infinity' || schema.enum[0] === '-Infinity')

/** Drop unknown members and parenthesize unions before rendering an intersection. */
const intersection = (members: ReadonlyArray<string>): string => {
  const concrete = members.filter((member) => member !== 'unknown')
  if (concrete.length === 0) return 'unknown'
  if (concrete.length === 1) return concrete[0] ?? 'unknown'
  return concrete.map((member) => (member.includes(' | ') ? `(${member})` : member)).join(' & ')
}

/**
 * Recursion ceiling for schema rendering. Object, array, and union recursion all increment
 * depth, so this bounds every recursion path - pathological or structurally cyclic schemas
 * degrade to `unknown` instead of overflowing the stack (rendering must never throw).
 */
const MAX_RENDER_DEPTH = 8

type RenderContext = {
  readonly definitions: Readonly<Record<string, JsonSchema>>
  /** Indented, JSDoc-annotated multiline rendering (model-visible signatures); compact single line otherwise. */
  readonly pretty: boolean
}

/** Enumerate schema children in reference order without traversing annotation-only values. */
const referenceChildren = (schema: JsonSchema): ReadonlyArray<JsonSchema> => [
  ...(schema.anyOf ?? []),
  ...(schema.oneOf ?? []),
  ...(schema.allOf ?? []),
  ...Object.values(schema.properties ?? {}),
  ...(schema.items === undefined ? [] : [schema.items]),
  ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
]

/** Detect unresolved or recursive references without looping through cyclic schema objects. */
const hasUnresolvedRef = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  seen: ReadonlySet<string> = new Set(),
  visited: ReadonlySet<JsonSchema> = new Set(),
): boolean => {
  if (visited.has(schema)) return false
  const nextVisited = new Set([...visited, schema])
  if (schema.$ref !== undefined) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
    const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true
    if (hasUnresolvedRef(definitions[name], definitions, new Set([...seen, name]), nextVisited))
      return true
  }
  return referenceChildren(schema).some((item) =>
    hasUnresolvedRef(item, definitions, seen, nextVisited),
  )
}

/**
 * Schema constraints a TypeScript type cannot express natively but a model benefits from,
 * surfaced as JSDoc tags (`@deprecated`, `@default`, `@format`, `@minItems`, `@maxItems`).
 */
const docTags = (schema: JsonSchema): Array<string> => {
  const tags: Array<string> = []
  if (schema.deprecated === true) tags.push('@deprecated')
  if (schema.default !== undefined) {
    // Unserializable defaults have no model-visible tag, matching the reference renderer.
    const rendered = Result.getOrElse(
      Result.try(() => JSON.stringify(schema.default)),
      () => undefined,
    )
    if (rendered !== undefined) tags.push(`@default ${rendered}`)
  }
  if (typeof schema.format === 'string') tags.push(`@format ${schema.format}`)
  if (typeof schema.minItems === 'number') tags.push(`@minItems ${schema.minItems}`)
  if (typeof schema.maxItems === 'number') tags.push(`@maxItems ${schema.maxItems}`)
  return tags
}

/**
 * Format a schema `description` plus `tags` as a JSDoc comment at the given indent,
 * preserving multi-line text (a single line stays `/** ... *\/`; multiple lines become a
 * `*`-prefixed block). `*\/` is neutralized so nothing can close the comment early, and
 * blank leading/trailing lines are trimmed. Returns "" (else a trailing newline) so
 * callers can prepend it directly to the field line.
 */
const jsdoc = (
  description: string | undefined,
  tags: ReadonlyArray<string>,
  pad: string,
): string => {
  const lines = [...(description === undefined ? [] : description.split('\n')), ...tags].map(
    (line) => line.replaceAll('*/', '* /').replace(/\s+$/, ''),
  )
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  if (lines.length === 0) return ''
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`
  const body = lines.map((line) => `${pad} *${line === '' ? '' : ` ${line}`}`).join('\n')
  return `${pad}/**\n${body}\n${pad} */\n`
}

/** Merge only locally declared definitions; every recursive branch keeps the same visible schema scope. */
const nestedContext = (schema: JsonSchema, ctx: RenderContext): RenderContext =>
  schema.definitions === undefined && schema.$defs === undefined
    ? ctx
    : { ...ctx, definitions: { ...ctx.definitions, ...schema.definitions, ...schema.$defs } }

/** Bound recursive rendering and preserve reference expansion, property names, and schema constraints. */
const renderSchema = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string => {
  if (depth > MAX_RENDER_DEPTH) return 'unknown'
  const nested = nestedContext(schema, ctx)
  if (schema.$ref) return renderReference(schema.$ref, schema, { ctx: nested, depth, seen })
  if (schema.const !== undefined) return renderLiteral(schema.const)
  if (schema.enum) return schema.enum.map(renderLiteral).join(' | ')
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) return renderAlternatives(alternatives, schema, { ctx: nested, depth, seen })
  if (schema.allOf) return renderIntersection(schema.allOf, schema, { ctx: nested, depth, seen })
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen))
      .join(' | ')
  }
  return renderConcrete(schema, nested, depth, seen)
}

type RenderState = {
  readonly ctx: RenderContext
  readonly depth: number
  readonly seen: ReadonlySet<string>
}

/** Expand one local reference without losing its sibling constraints or recursive-reference guard. */
const renderReference = (reference: string, schema: JsonSchema, state: RenderState): string => {
  const { ctx: nested, depth, seen } = state
  const segment = reference.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
  const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
  if (!name || !nested.definitions[name] || seen.has(name)) return 'unknown'
  return intersection([
    renderSchema(nested.definitions[name], nested, depth, new Set([...seen, name])),
    renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
  ])
}

/** Render only real union members; preserve the reference's special Effect-schema artifacts. */
const renderAlternatives = (
  alternatives: ReadonlyArray<JsonSchema>,
  schema: JsonSchema,
  state: RenderState,
): string => {
  const { ctx: nested, depth, seen } = state
  // Effect's number schema emits `anyOf: [{ type: "number" }, { const: "NaN" },
  // { const: "Infinity" }, { const: "-Infinity" }]`. Collapse only that artifact;
  // real JSON Schema unions such as `string | number` or `number | null` must keep
  // every branch.
  if (
    alternatives.some((item) => item.type === 'number') &&
    alternatives.every((item) => item.type === 'number' || effectNumberSentinel(item))
  )
    return 'number'
  // An empty Schema.Struct({}) emits `anyOf: [{ type: "object" }, { type: "array" }]`
  // (no properties/items); render the bare shape as {} instead of `{} | Array<unknown>`.
  if (
    alternatives.length === 2 &&
    alternatives[0]?.type === 'object' &&
    alternatives[0].properties === undefined &&
    alternatives[1]?.type === 'array' &&
    alternatives[1].items === undefined
  ) {
    return '{}'
  }
  const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen))
  if (members.some((member) => member === 'unknown')) return 'unknown'
  return intersection([
    members.join(' | '),
    renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
  ])
}

/** Keep intersections conservative when an unresolved reference prevents a trustworthy signature. */
const renderIntersection = (
  membersSchema: ReadonlyArray<JsonSchema>,
  schema: JsonSchema,
  state: RenderState,
): string => {
  const { ctx: nested, depth, seen } = state
  const members = membersSchema.map((item) => renderSchema(item, nested, depth + 1, seen))
  if (membersSchema.some((item) => hasUnresolvedRef(item, nested.definitions))) return 'unknown'
  return intersection([
    renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen),
    ...members,
  ])
}

/** Render concrete primitive and collection shapes after references and composition are resolved. */
const renderConcrete = (
  schema: JsonSchema,
  nested: RenderContext,
  depth: number,
  seen: ReadonlySet<string>,
): string => {
  if (schema.type === 'string') return 'string'
  if (schema.type === 'number' || schema.type === 'integer') return 'number'
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'null') return 'null'
  if (schema.type === 'array')
    return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`
  if (schema.type === 'object' || schema.properties)
    return renderObject(schema, nested, depth, seen)
  return 'unknown'
}

/** Keep compact and pretty field rendering aligned, including required keys and index signatures. */
const renderObject = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth: number,
  seen: ReadonlySet<string>,
): string => {
  const nested = ctx
  const required = new Set(schema.required ?? [])
  const properties = Object.entries(schema.properties ?? {})
  const additional = schema.additionalProperties
  const indexType =
    additional && typeof additional === 'object'
      ? renderSchema(additional, nested, depth + 1, seen)
      : undefined
  const field = ([name, value]: readonly [string, JsonSchema]) =>
    `${renderKey(name)}${required.has(name) ? '' : '?'}: ${renderSchema(value, nested, depth + 1, seen)}`

  if (!ctx.pretty) {
    const fields = properties.map(field)
    if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`)
    return fields.length === 0 ? '{}' : `{ ${fields.join('; ')} }`
  }

  // Pretty: an indented block, each described field preceded by its JSDoc comment.
  if (properties.length === 0 && indexType === undefined) return '{}'
  const pad = '  '.repeat(depth + 1)
  const lines = properties.map(
    (entry) => `${jsdoc(entry[1].description, docTags(entry[1]), pad)}${pad}${field(entry)},`,
  )
  if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`)
  return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`
}

export const toTypeScript = (schema: Schema.Top, decoded = false, pretty = false): string => {
  return Result.match(
    Result.try(() => {
      const visible = decoded ? Schema.toType(schema) : schema
      const document = Schema.toJsonSchemaDocument(visible) as {
        readonly schema: JsonSchema
        readonly definitions?: Readonly<Record<string, JsonSchema>>
      }
      return renderSchema(document.schema, { definitions: document.definitions ?? {}, pretty })
    }),
    {
      onSuccess: (value) => value,
      onFailure: () => {
        return 'unknown'
      },
    },
  )
}

/** Renders a raw JSON Schema document as a TypeScript type string. */
export const jsonSchemaToTypeScript = (schema: JsonSchema, pretty = false): string => {
  return Result.match(
    Result.try(() => {
      return renderSchema(schema, {
        definitions: { ...schema.definitions, ...schema.$defs },
        pretty,
      })
    }),
    {
      onSuccess: (value) => value,
      onFailure: () => {
        return 'unknown'
      },
    },
  )
}

/**
 * The model-visible TypeScript type of a tool's input. `pretty` renders an indented
 * multiline block with schema descriptions and constraints as JSDoc comments on the
 * fields; the default stays the compact single-line form.
 */
export const inputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  isEffectSchema(definition.input)
    ? toTypeScript(definition.input, false, pretty)
    : jsonSchemaToTypeScript(definition.input, pretty)

/**
 * The model-visible TypeScript type of a tool's result; tools without an output schema
 * return `unknown`. `pretty` renders the JSDoc-annotated multiline form, as for inputs.
 */
export const outputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  definition.output === undefined
    ? 'unknown'
    : isEffectSchema(definition.output)
      ? toTypeScript(definition.output, true, pretty)
      : jsonSchemaToTypeScript(definition.output, pretty)

/**
 * Decodes tool input before `run` is invoked. Effect Schemas validate with a typed failure;
 * JSON-Schema-described inputs pass through unvalidated (render-only).
 */
const compileDecoder = Schema.decodeUnknownEffect
const decoders = new WeakMap<
  Schema.Decoder<unknown>,
  ReturnType<typeof compileDecoder<Schema.Decoder<unknown>>>
>()

/** Compile each dynamic host schema once; definitions reuse the same schema identity across calls. */
const decoder = (schema: Schema.Decoder<unknown>) => {
  const existing = decoders.get(schema)
  if (existing !== undefined) return existing
  const compiled = compileDecoder(schema)
  decoders.set(schema, compiled)
  return compiled
}

/**
 * Decodes with a host schema and reports any failure as text. A schema's own transformation may
 * throw: with the Effect decoder that is a defect, which no typed handler sees, so the reference's
 * guarantee (a decode that goes wrong is an invalid input or output, and the tool's end is still
 * observed) would be lost. The throw is caught here and becomes the same failure. Interruption is
 * not a failure and passes through.
 */
const decoded = (schema: Schema.Decoder<unknown>, value: unknown): Effect.Effect<unknown, string> =>
  Effect.suspend(() => decoder(schema)(value)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(String(Cause.squash(cause))),
    ),
  )

export const decodeInput = <R>(
  definition: Definition<R>,
  value: unknown,
): Effect.Effect<unknown, string> =>
  isEffectSchema(definition.input) ? decoded(definition.input, value) : Effect.succeed(value)

/**
 * Decodes a tool result before it is exposed to the program. Effect Schemas validate and
 * transform with a typed failure; JSON Schema outputs and tools without an output schema pass
 * the host value through unchanged.
 */
export const decodeOutput = <R>(
  definition: Definition<R>,
  value: unknown,
): Effect.Effect<unknown, string> =>
  definition.output !== undefined && isEffectSchema(definition.output)
    ? decoded(definition.output, value)
    : Effect.succeed(value)
