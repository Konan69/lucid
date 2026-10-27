import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Notes } from '../../notes.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  Harness,
  hook,
  ToolResultEntry,
  ToolTask,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Effect, Result, Schema } from 'effect'
import { expect } from 'vitest'

const decodeArguments = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))
const decodeReceipt = Schema.decodeUnknownResult(
  Schema.Struct({ customTool: Schema.String, output: Schema.Json }),
)

/** Each assertion crosses a real provider turn, intent validation, durable execution, settlement
 * and transcript projection. Only the remote RPC receipt is controlled by each test's Layer. */
// @effect-diagnostics-next-line asyncFunction:off -- Test fixture drives the Promise-only Pi Harness public API.
export async function roundTrip(
  tool: ToolRegistration,
  value: Schema.JsonObject,
  signal: AbortSignal,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-tool-'))
  return (
    Promise.resolve()
      // @effect-diagnostics-next-line asyncFunction:off -- The fixture owns the native storage through the complete Pi Promise lifecycle.
      .then(async () => {
        const args = Result.getOrThrow(decodeArguments(value))
        const faux = fauxProvider({ tokensPerSecond: 0 })
        const models = createModels()
        models.setProvider(faux.provider)
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall(tool.name, args, { id: 'fixture-call' }), {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('Finished.'),
        ])
        let reported: ToolExecutionResult = {}
        const registry = createRegistry()
        registry.install(
          defineExtension({
            name: 'fixture',
            tools: [tool],
            hooks: [
              hook(ToolTask, {
                afterTool: (_call, result) => {
                  reported = result
                  return undefined
                },
              }),
            ],
          }),
        )
        const harness = await Harness.open(
          await openNodeSqliteStorage(NodePath.join(directory, 'person.sqlite'), { prefix: 'pi_' }),
          { models, registry },
          BACKGROUND_CONTEXT,
        )
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        })
        const cancel = () => {
          void root.abort(BACKGROUND_CONTEXT)
        }
        signal.addEventListener('abort', cancel, { once: true })
        return (
          Promise.resolve()
            // @effect-diagnostics-next-line asyncFunction:off -- Test fixture drives the Promise-only Pi Harness public API.
            .then(async () => {
              const submission = await root.submit(
                { type: 'input', content: 'Run the tool.' },
                BACKGROUND_CONTEXT,
              )
              await submission.wait(BACKGROUND_CONTEXT)
              const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)
              const entry = entries.items.find((candidate) => ToolResultEntry.is(candidate))
              const message =
                entry === undefined || entry.model === undefined ? undefined : entry.model[0]
              if (message === undefined || message.role !== 'toolResult')
                throw new Error('Pi did not persist a tool result.')
              if (!message.isError) expect(message.details).toEqual(reported.details)
              return {
                message,
                terminate: reported.control !== undefined && reported.control.terminate === true,
                calls: faux.state.callCount,
              }
            })
            // @effect-diagnostics-next-line asyncFunction:off -- Test fixture drives the Promise-only Pi Harness public API.
            .finally(async () => {
              signal.removeEventListener('abort', cancel)
              await harness.close(BACKGROUND_CONTEXT)
            })
        )
      })
      .finally(() => NodeFSP.rm(directory, { recursive: true, force: true }))
  )
}

/** Existing product receipt assertions read persisted display details, never a direct callback. */
// @effect-diagnostics-next-line asyncFunction:off -- Test fixture drives the Promise-only Pi Harness public API.
export async function invoke(
  tool: ToolRegistration,
  call: {
    data: unknown
    signal: AbortSignal
    toolCallId?: string
    log?: { info: () => void; warn: () => void; error: () => void }
  },
) {
  const result = await roundTrip(tool, Result.getOrThrow(decodeArguments(call.data)), call.signal)
  const output = Result.getOrThrow(decodeReceipt(result.message.details))
  return { output: output.output, terminate: result.terminate }
}

/** Native image assertions read the actual persisted model blocks and display receipt. */
export function nativeTool(tool: ToolRegistration) {
  return {
    ...tool,
    // @effect-diagnostics-next-line asyncFunction:off -- Test fixture drives the Promise-only Pi Harness public API.
    execute: async (
      _call: string,
      value: Schema.JsonObject,
      signal: AbortSignal = new AbortController().signal,
    ) => {
      const result = await roundTrip(tool, value, signal)
      return {
        content: result.message.content,
        details: result.message.details,
        terminate: result.terminate,
        isError: result.message.isError,
      }
    },
  }
}

/** Catalogue tests that exercise RPC never use notes; fail if that assumption changes. */
export const unusedNotes: Notes['Service'] = Notes.of({
  index: () => Effect.die('Unexpected note index'),
  list: () => Effect.die('Unexpected note listing'),
  search: () => Effect.die('Unexpected note search'),
  read: () => Effect.die('Unexpected note read'),
  write: () => Effect.die('Unexpected note write'),
  delete: () => Effect.die('Unexpected note delete'),
})
