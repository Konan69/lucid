import { CodeToolNames } from '@vivid/contracts/code'
import { Effect, Option, Predicate, Schema } from 'effect'
import { bytes } from './budgets.ts'
import { jsonSchemaToTypeScript } from './interpreter/schema.ts'

const acceptsNames = Schema.is(CodeToolNames)

/** JSON is already decoded; retain its value type when distinguishing readonly arrays from records. */
const schemaObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/**
 * One provider schema as a TypeScript type on one line. The renderer is the interpreter's own
 * (`interpreter/schema.ts`, `jsonSchemaToTypeScript`, from opencode's `tool-schema.ts`): its
 * compact form writes no descriptions, so no provider text can become a comment, it never throws,
 * and a schema it cannot follow (a broken `$ref`, too deep) is `unknown`. A type longer than its
 * share of the signature is `unknown` too, so a signature is never cut in the middle of a type.
 */
const schemaType = (schema: Schema.Json, maximum: number) => {
  if (schema === false) return 'never'
  if (!schemaObject(schema)) return 'unknown'
  const rendered = jsonSchemaToTypeScript(schema)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  return bytes(rendered) > maximum ? 'unknown' : rendered
}

/** String literals must remain one executable line, including JavaScript's Unicode separators. */
const literal = (name: string) =>
  JSON.stringify(name).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')

/**
 * The one way a program calls an Integration tool. The interpreter resolves `tools.*` against a
 * fixed tree, and accounts are named by the Person, so the account and the tool travel as
 * arguments of `use_tool`, where they meet the same check as a call the model makes alone.
 */
const toolCall = (account: string, name: string) =>
  `tools.use_tool({account: ${literal(account)}, tool: ${literal(name)}, input, summary, rationale})`

/** The wrapper has a fixed byte cost; reserving it keeps truncation on whole schema types. */
const toolSignature = (
  tool: { readonly account: string; readonly name: string },
  input: string,
  output: string,
) =>
  `(args: {account: ${literal(tool.account)}; tool: ${literal(tool.name)}; input: ${input}; summary: string; rationale: string}) => Promise<{ok: true; output: ${output}} | {ok: false; reason: string}>`

/** Discovery must not advertise names the production use_tool ingress cannot accept. */
export const callableTool = (tool: { readonly account: string; readonly name: string }) =>
  acceptsNames({ account: tool.account, tool: tool.name })

/**
 * What discovery tells the model about one tool: the call expression to write in a program and
 * its TypeScript signature. The output type and the wrapper are reserved first, then the input,
 * within 4,000 UTF-8 bytes. Only an absent provider output schema becomes Json.
 */
export const discoveredTool = Effect.fn('Code.discoveredTool')(function* (tool: {
  readonly account: string
  readonly name: string
  readonly input: Schema.Json
  readonly output: Option.Option<Schema.Json>
}) {
  const maximum = 4_000
  const outputBudget = maximum - bytes(toolSignature(tool, 'unknown', ''))
  const output = Option.match(tool.output, {
    onNone: () => 'Json',
    onSome: (schema) => schemaType(schema, outputBudget),
  })
  const input = schemaType(tool.input, maximum - bytes(toolSignature(tool, '', output)))
  return yield* Effect.succeed({
    call: toolCall(tool.account, tool.name),
    signature: toolSignature(tool, input, output),
  })
})
