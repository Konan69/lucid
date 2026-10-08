import * as NodeWorkerThreads from 'node:worker_threads'
import { FixtureFailed } from './harness.ts'
import { runForPi } from '../pi.ts'
// Disposable child of conformance/sequential.test.ts: die only after the second task is waiting.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { tool } from 'ai'
import { z } from 'zod'
import { Effect, Option, Stream } from 'effect'
import { continueRun, decide, streamRun, toolsExtension, waiting } from '../main.ts'

const context = BACKGROUND_CONTEXT
/** Drive the Promise consumer entry, as before conversion, then die at the committed crash boundary. */
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
    return yield* new FixtureFailed({ cause: new Error('Expected disposable SQLite path') })
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
        fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
      ],
      { stopReason: 'toolUse' },
    ),
  ])
  const registry = createRegistry()
  registry.install(
    yield* Effect.promise(() =>
      toolsExtension(
        'conformance',
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: ({ amount }) => Promise.resolve(amount),
          }),
        },
        { execution: 'sequential', approval: { pay: true } },
      ),
    ),
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
      try: () =>
        Harness.open(
          storage,
          { models, registry, settings: { toolExecution: 'sequential' } },
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
  const stream = yield* Effect.promise(() =>
    streamRun(
      harness,
      { conversationId: root.id, content: 'Pay both', requestId: 'crash-sequential' },
      context,
    ),
  )
  const chunks = yield* Stream.runCollect(
    Stream.fromReadableStream({
      evaluate: () => stream,
      onError: (cause) => new FixtureFailed({ cause }),
    }),
  )
  const start = chunks.find((chunk) => chunk.type === 'start')
  if (start === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected message start') })
  const messageId = Option.getOrThrow(Option.fromNullishOr(start.messageId))
  const first = (yield* Effect.promise(() => waiting(harness, root.id, context))).find(
    (row) => row.callId === 'c1',
  )
  if (first === undefined) return yield* new FixtureFailed({ cause: new Error('Expected c1 hold') })
  yield* Effect.promise(() =>
    decide(harness, root.id, { holdId: first.holdId, approved: true }, context),
  )
  const continued = yield* Effect.promise(() =>
    continueRun(harness, root.id, { messageId, known: new Set(['c1']) }, context),
  )
  yield* Stream.runDrain(
    Stream.fromReadableStream({
      evaluate: () => continued,
      onError: (cause) => new FixtureFailed({ cause }),
    }),
  )
  if (
    !(yield* Effect.promise(() => waiting(harness, root.id, context))).some(
      (row) => row.callId === 'c2',
    )
  )
    return yield* new FixtureFailed({ cause: new Error('Expected c2 hold') })
  process.stdout.write('c2-waiting\n')
  return yield* Effect.never
})
await runForPi(Effect.scoped(main()), undefined)
