import * as NodeWorkerThreads from 'node:worker_threads'
import { FixtureFailed } from './harness.ts'
import { runForPi } from '../pi.ts'
import { Effect, Stream } from 'effect'
// Disposable child of conformance/delivery.test.ts. Die after answer admission, before its receipt
// is recorded: Pi session.js publishes commits synchronously before the committing Promise resolves.
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
import { answer, streamRun, toolsExtension, waiting } from '../core.ts'

const context = BACKGROUND_CONTEXT
/** Own the disposable child process's async setup, interactions and readiness receipt. */
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
    fauxAssistantMessage([fauxToolCall('later', { question: 'Which?' }, { id: 'x' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxToolCall('pay', { amount: 100 }, { id: 'pay' })], {
      stopReason: 'toolUse',
    }),
  ])
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'conformance',
      {
        later: tool({ inputSchema: z.object({ question: z.string() }) }),
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => Promise.resolve({ receipt: amount }),
        }),
      },
      { approval: { pay: true }, answers: { later: 'later' } },
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
  yield* Stream.runDrain(
    streamRun(
      harness,
      { conversationId: root.id, content: 'Ask then pay', requestId: 'crash-answer' },
      context,
    ),
  )
  const questions = yield* waiting(harness, root.id, context)
  const question = questions.find((row) => row.kind === 'later')
  if (question === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected late question') })
  harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (change) =>
          change.type === 'submission' && change.value.requestId === `answer:${question.holdId}:0`,
      )
    )
      process.kill(process.pid, 'SIGKILL')
  })
  yield* answer(harness, root.id, { holdId: question.holdId, output: 'savings' }, context)
  return yield* new FixtureFailed({
    cause: new Error('Expected death before answer receipt commit'),
  })
})
await runForPi(Effect.scoped(main()), undefined)
