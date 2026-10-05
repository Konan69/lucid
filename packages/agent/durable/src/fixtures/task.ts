// Verify Pi's pending slot identity before intent and across an unclean process death.
// generation.ts startToolRound creates the slot and task atomically; ToolTask.call invokes this hook.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  LiveDoc,
  ToolTask,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Effect, Option } from 'effect'
import * as Pi from '../pi.ts'

const context = BACKGROUND_CONTEXT
const [, , file] = process.argv
if (file === undefined) throw new Error('Expected a disposable SQLite file')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('work', {}, { id: 'pending' })], { stopReason: 'toolUse' }),
])
const registry = createRegistry()
registry.install(
  defineExtension({
    name: 'identity',
    tools: [
      defineTool({
        name: 'work',
        description: 'Observe the pending task',
        parameters: Type.Object({}),
        execute: (_args, _api, callbackContext) =>
          Pi.runForPi(Effect.never, callbackContext.abortSignal),
      }),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (_call, api, callbackContext) =>
          Pi.runForPi(
            Effect.gen(function* () {
              const live = Option.getOrThrow(
                yield* Pi.snapshot(api, LiveDoc, api.conversationId, callbackContext),
              )
              const slot = Option.getOrThrow(
                Option.fromNullishOr(
                  (live.tools ?? []).find((candidate) => candidate.taskId === api.taskId),
                ),
              )
              if (slot === undefined) return yield* Effect.fail(new Error('Missing pending slot'))
              process.stdout.write(
                JSON.stringify({
                  taskId: api.taskId,
                  slotTaskId: slot.taskId,
                  status: slot.status,
                }) + '\n',
              )
              return yield* Effect.never
            }),
            callbackContext.abortSignal,
          ),
      }),
    ],
  }),
)
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context)
const root = await harness.root(context, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
await root.submit({ type: 'input', content: 'Work', requestId: 'pending' }, context)
