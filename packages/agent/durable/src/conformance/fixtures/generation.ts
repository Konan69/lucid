import * as NodeWorkerThreads from 'node:worker_threads'
import { FixtureFailed } from '../../fixtures/harness.ts'
// An owned child stops its first generation after a committed partial. The parent kills this
// captured process, then proves attribution from real recovery on the same SQLite/PG storage.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, LiveDoc } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Config, Effect, Schema } from 'effect'
import { runForPi } from '../../pi.ts'
import { Pool } from 'pg'
import { openPgStorage } from '../../postgres/main.ts'
import { streamingProvider, waitForFrame } from '../../fixtures/provider.ts'

/** Process ingress owns storage initialization and the deliberate crash; no cleanup runs after SIGKILL. */
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
  const context = BACKGROUND_CONTEXT
  const [, , backend, address] = process.argv
  if (address === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected disposable storage address') })
  const storage = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      if (backend === 'sqlite')
        return yield* Effect.tryPromise({
          try: () => openNodeSqliteStorage(address),
          catch: (cause) => new FixtureFailed({ cause }),
        })
      const connectionString = yield* Config.schema(Schema.String, 'VIVID_TEST_DATABASE_URL')
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString })),
        (value) => Effect.promise(value.end.bind(value)),
      )
      return yield* Effect.tryPromise({
        try: () => openPgStorage(pool, address),
        catch: (cause) => new FixtureFailed({ cause }),
      })
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const faux = streamingProvider({
    partialFamily: 'parsed',
    onFrame: (event, signal) =>
      event.type === 'text_delta' ? waitForFrame(Effect.never, signal) : Effect.void,
  })
  faux.setResponses([fauxAssistantMessage('Interrupted first generation.')])
  const models = createModels()
  models.setProvider(faux.provider)
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 0 } } },
          context,
        ),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  const watch = yield* Effect.promise(() => harness.watchDoc(LiveDoc, root.id, context))
  if (watch === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected live document') })
  let announced = false
  watch.start(function reportGeneration(live) {
    if (
      !announced &&
      live !== null &&
      live.run !== undefined &&
      live.generation !== undefined &&
      live.generation.message !== undefined
    ) {
      announced = true
      if (process.send === undefined) throw new Error('Expected parent IPC channel')
      process.send(live.run.taskId)
    }
    return Promise.resolve()
  })
  yield* Effect.promise(() =>
    root.submit({ type: 'input', content: 'Start', requestId: 'crashed' }, context),
  )
  return yield* Effect.never
})
await runForPi(Effect.scoped(main()), undefined)
