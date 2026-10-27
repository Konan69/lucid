import { Record, Result, Schema } from 'effect'

/** Every tool Vivid mounts, including file tools and skill activation. */
export const ToolName = Schema.Literals([
  'activate_skill',
  'add_integration',
  'ask_person',
  'bash',
  'browse',
  'connect',
  'copy_signin',
  'create_project',
  'delete_note',
  'edit',
  'find_events',
  'find_integrations',
  'find_tools',
  'glob',
  'grep',
  'list_notes',
  'list_watches',
  'make_integration',
  'notify_person',
  'post',
  'read',
  'read_document',
  'read_note',
  'read_page',
  'read_skill',
  'recall',
  'remember',
  'run_code',
  'save_skill',
  'search_library',
  'search_notes',
  'stop_watching',
  'suggest_replies',
  'test_integration',
  'use_desktop',
  'use_person_computer',
  'use_tool',
  'watch',
  'write',
  'write_document',
  'write_note',
])
export type ToolName = typeof ToolName.Type

type ToolTable = { readonly [Name in ToolName]: Name }

const isToolRecord = Schema.is(Schema.Record(ToolName, ToolName))

/** Record construction loses each key's literal value. Check that relation rather than
 * casting a string dictionary into the tool definition's dependent type. */
const ToolTable = Schema.declare<ToolTable>(
  (input): input is ToolTable =>
    isToolRecord(input) && ToolName.literals.every((name) => input[name] === name),
)

/** A broken authored vocabulary must prevent startup, before any tool can mount under a wrong name. */
export const Tool: ToolTable = Result.getOrThrow(
  Schema.decodeUnknownResult(ToolTable)(
    Record.fromIterableWith(ToolName.literals, (name) => [name, name]),
  ),
)

/**
 * The suggested replies Vivid may offer under a reply (`suggest_replies`): few and short, so they
 * read as taps and not as a menu. The runtime refuses more and the clients decode no more.
 */
export const SUGGESTED_REPLIES_MOST = 3
export const SUGGESTED_REPLY_LONGEST = 40

/** Programs reach only this subset of the tools mounted for an ordinary turn. */
export const CodeCallKind = ToolName.pick(['find_tools', 'use_tool', 'browse', 'read_page'])
export type CodeCallKind = typeof CodeCallKind.Type
