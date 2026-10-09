import { schemaToType } from '@earendil-works/pi-codemode/declarations'
import { CodeToolNames } from '@vivid/contracts/code'
import { Effect, Option, Predicate, Schema } from 'effect'
import { bytes } from './budgets.ts'

const acceptsNames = Schema.is(CodeToolNames)

/** JSON is already decoded; retain its value type when distinguishing readonly arrays from records. */
const schemaObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** Replace characters the JavaScript lexer can treat as comment boundaries or invisible controls. */
function commentCharacter(character: string) {
  const code = character.charCodeAt(0)
  return code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233
    ? ' '
    : character
}

/** Schema strings can become pi's comments: it splits only on /\r?\n/, not every control.
 * Sanitize descriptions before rendering; preserve enum values and property names so C0/C1 and Unicode separators cannot escape comments.
 * This recursive provider adapter runs inside Effect.try along with pi's recursive renderer.
 */
function commentText(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(commentText)
  if (schemaObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'description' && Predicate.isString(item)
          ? Array.from(item, commentCharacter).join('')
          : commentText(item),
      ]),
    )
  return value
}

/** Malformed $refs and excessive recursion are provider-local failures, never discovery defects. */
const schemaType = Effect.fn('Code.schemaType')(function* (schema: Schema.Json, maximum: number) {
  if (schema === false) return 'never'
  return yield* Effect.try(() => {
    const safe = commentText(schema)
    if (!schemaObject(safe)) return 'unknown'
    const rendered = schemaToType(safe, { maxChars: maximum })
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029')
    return bytes(rendered) > maximum ? 'unknown' : rendered
  }).pipe(Effect.orElseSucceed(() => 'unknown'))
})

/** String literals must remain one executable line, including JavaScript's Unicode separators. */
const literal = (name: string) =>
  JSON.stringify(name).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')

/** A then property is reserved by Promise assimilation; use the ordinary object bridge instead. */
function toolCall(account: string, name: string) {
  if (account === 'then' || name === 'then')
    return `tools.use_tool({account: ${literal(account)}, tool: ${literal(name)}, input, summary, rationale})`
  const member = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `.${name}` : `[${literal(name)}]`
  return `accounts[${literal(account)}]${member}`
}

/** The wrapper has a fixed byte cost; reserving it keeps truncation on whole schema types. */
function toolSignature(
  tool: { readonly account: string; readonly name: string },
  input: string,
  output: string,
) {
  const parameters =
    tool.account === 'then' || tool.name === 'then'
      ? `args: {account: ${literal(tool.account)}; tool: ${literal(tool.name)}; input: ${input}; summary: string; rationale: string}`
      : `input: ${input}, about: {summary: string; rationale: string}`
  return `(${parameters}) => Promise<{ok: true; output: ${output}} | {ok: false; reason: string}>`
}

/** Discovery must not advertise names the production use_tool ingress cannot accept. */
export const callableTool = (tool: { readonly account: string; readonly name: string }) =>
  acceptsNames({ account: tool.account, tool: tool.name })

/**
 * Adapt Executor CodeMode.toolExpression (packages/mcp/src/implementation/execute.ts) to exact
 * Vivid names. Pi declarations.js/schemaToType replaces oversized types with unknown; reserve
 * output and wrapper bytes first, then input. The 4,000 UTF-8 byte bound protects IPC frames and
 * avoids runtime text clipping. Only an absent provider output schema becomes Json.
 */
export const discoveredTool = Effect.fn('Code.discoveredTool')(function* (tool: {
  readonly account: string
  readonly name: string
  readonly input: Schema.Json
  readonly output: Option.Option<Schema.Json>
}) {
  const maximum = 4_000
  const outputBudget = maximum - bytes(toolSignature(tool, 'unknown', ''))
  const output = yield* Option.match(tool.output, {
    onNone: () => Effect.succeed('Json'),
    onSome: (schema) => schemaType(schema, outputBudget),
  })
  const input = yield* schemaType(tool.input, maximum - bytes(toolSignature(tool, '', output)))
  return { call: toolCall(tool.account, tool.name), signature: toolSignature(tool, input, output) }
})
