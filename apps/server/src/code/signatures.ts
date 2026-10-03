import {
  DEFAULT_INPUT_SCHEMA_MAX_CHARS,
  schemaToType,
} from '@earendil-works/pi-codemode/declarations'
import { Predicate, type Schema } from 'effect'

/** Pi declarations.js/schemaToType accepts schema objects; boolean schemas are already complete types. */
function schemaType(schema: Schema.Json, maximum: number) {
  if (schema === false) return 'never'
  if (!Predicate.isObject(schema) || Array.isArray(schema)) return 'unknown'
  // Pi splits description comments only on CR/LF; escape JavaScript's other line separators
  // so a provider description cannot end a line comment early (declarations.js/objectType).
  const rendered = schemaToType(schema, { maxChars: maximum })
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
  return rendered.length > maximum ? 'unknown' : rendered
}

/** The wrapper has a fixed cost; reserving it keeps truncation on whole schema types. */
function toolSignature(input: string, output: string) {
  return `(input: ${input}, about: {summary: string; rationale: string}) => Promise<{ok: true; output: ${output}} | {ok: false; reason: string}>`
}

/**
 * Adapt CodeMode.toolExpression in Executor packages/mcp/src/implementation/execute.ts's search
 * projection to Vivid's exact account/tool names.
 * Pi declarations.js/schemaToType confines descriptions to line comments and replaces oversized
 * types with unknown. Apply that behavior within the runtime's generic 4,000-character text
 * budget so discovery never cuts a declaration mid-type. Reserve the wrapper, then the output
 * type, then render input into the remaining space. Only a missing output schema becomes Json.
 */
export function discoveredTool(tool: {
  readonly account: string
  readonly name: string
  readonly input: Schema.Json
  readonly output?: Schema.Json
}) {
  const member = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tool.name)
    ? `.${tool.name}`
    : `[${JSON.stringify(tool.name)}]`
  const maximum = Math.min(DEFAULT_INPUT_SCHEMA_MAX_CHARS, 4_000)
  const outputBudget = maximum - toolSignature('unknown', '').length
  const output = tool.output === undefined ? 'Json' : schemaType(tool.output, outputBudget)
  const input = schemaType(tool.input, maximum - toolSignature('', output).length)
  return {
    call: `accounts[${JSON.stringify(tool.account)}]${member}`,
    signature: toolSignature(input, output),
  }
}
