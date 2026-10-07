import * as NodeWorkerThreads from 'node:worker_threads'
import { FixtureFailed } from './harness.ts'
// Child process of recovery.test.ts. It starts a run whose tool never returns, reports that the tool
// is running, and is then killed by the test. Nothing here closes the harness: the point is an
// unclean death with a tool call in flight.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { Effect } from 'effect'
import { runForPi } from '../pi.ts'

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
    return yield* new FixtureFailed({ cause: new Error('usage: crash.ts <sqlite file>') })

  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('report', {}, { id: 'call-1' })], { stopReason: 'toolUse' }),
  ])

  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'report',
      tools: [
        defineTool({
          name: 'report',
          description: 'Build the report',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: (_args, _api, callbackContext) =>
            runForPi(
              Effect.sync(() => {
                process.stdout.write('tool-running\n')
              }).pipe(Effect.andThen(Effect.never)),
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
    root.submit({ type: 'input', content: 'Build the report', requestId: 'r1' }, context),
  )
  return yield* Effect.never
})
await runForPi(Effect.scoped(main()), undefined)
