import * as NodeWorkerThreads from 'node:worker_threads'
import { FixtureFailed } from './harness.ts'
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
/** One process ingress keeps scoped storage open until the parent kills this exact child. */
const main = Effect.fn('Test.main')(function* () {
  // A pending Effect has no Node handle. Keep this owned child alive until the parent's SIGKILL,
  // rather than letting an unsettled top-level await exit before the crash boundary is observed.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const channel = new NodeWorkerThreads.MessageChannel()
      channel.port1.on('message', () => {})
      return channel
    }),
    (channel) =>
      Effect.sync(() => {
        channel.port1.close()
        channel.port2.close()
      }),
  )
  const [, , file] = process.argv
  if (file === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected a disposable SQLite file') })
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
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(file),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Harness.open(storage, { models, registry }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  yield* Effect.promise(() =>
    root.submit({ type: 'input', content: 'Work', requestId: 'pending' }, context),
  )
  return yield* Effect.never
})
await Pi.runForPi(Effect.scoped(main()), undefined)
