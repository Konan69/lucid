import {
  DEFAULT_INPUT_SCHEMA_MAX_CHARS,
  schemaToType,
} from '@earendil-works/pi-codemode/declarations'
import { Predicate, type Schema } from 'effect'

/** Pi declarations.js/schemaToType accepts schema objects; boolean schemas are already complete types. */
function schemaType(schema: Schema.Json) {
  if (schema === false) return 'never'
  if (!Predicate.isObject(schema) || Array.isArray(schema)) return 'unknown'
  // Pi splits description comments only on CR/LF; escape JavaScript's other line separators
  // so a provider description cannot end a line comment early (declarations.js/objectType).
  return schemaToType(schema, { maxChars: DEFAULT_INPUT_SCHEMA_MAX_CHARS })
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
}

/**
 * Port Executor implementation/execute.ts's segment access to Vivid's exact account/tool names.
 * Pi declarations.js/schemaToType confines descriptions to line comments and replaces oversized
 * types with unknown. Apply that cap to both types; only a missing output schema becomes Json.
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
  const input = schemaType(tool.input)
  const output = tool.output === undefined ? 'Json' : schemaType(tool.output)
  return {
    call: `accounts[${JSON.stringify(tool.account)}]${member}`,
    signature: `(input: ${input}, about: {summary: string; rationale: string}) => Promise<{ok: true; output: ${output}} | {ok: false; reason: string}>`,
  }
}
