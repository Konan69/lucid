import { Record, Result, Schema } from 'effect'

/** Every tool Vivid mounts, including file tools and skill activation. */
export const ToolName = Schema.Literals([
  'activate_skill',
  'add_integration',
  'add_todo',
  'ask_person',
  'bash',
  'browse',
  'complete_todo',
  'connect',
  'copy_signin',
  'create_project',
  'delete_memory',
  'drop_owed',
  'drop_todo',
  'edit',
  'find_events',
  'find_integrations',
  'find_tools',
  'get_capabilities',
  'computer_health',
  'recover_computer',
  'forget_memory',
  'read_skill_file',
  'glob',
  'grep',
  'inspect_file',
  'list_memory',
  'list_todos',
  'list_watches',
  'make_integration',
  'notify_person',
  'plan_forget',
  'post',
  'publish_file',
  'read',
  'read_document',
  'read_memory',
  'read_page',
  'read_project',
  'read_skill',
  'request_handoff',
  'resolve_owed',
  'run_code',
  'save_skill',
  'search_library',
  'search_memory',
  'stop_watching',
  'suggest_replies',
  'test_integration',
  'track_owed',
  'use_desktop',
  'use_person_computer',
  'update_owed',
  'update_project',
  'use_tool',
  'watch',
  'write',
  'write_document',
  'write_memory',
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
