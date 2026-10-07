import * as NodeWorkerThreads from 'node:worker_threads'
import { runForPi } from '../../pi.ts'
import { FixtureFailed } from '../../fixtures/harness.ts'
import { Effect } from 'effect'
import * as NodeEvents from 'node:events'

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

import { toolsExtension } from '../../tools.ts'

/**
 * Pi harness-tools-recovery.test.ts: interruption after intent, adapted to a real process death.
 * Like src/fixtures/crash.ts, report execution only after Pi has persisted the call's intent.
 * The bridge supplies replay policy; no test writes Pi task checkpoints or patches its scheduler.
 */
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
  const [, , file, policy] = process.argv
  if (file === undefined || (policy !== 'safe' && policy !== 'unsafe'))
    return yield* new FixtureFailed({
      cause: new Error('Expected database file and replay policy'),
    })
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('work', {}, { id: 'interrupted' })], {
      stopReason: 'toolUse',
    }),
  ])
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'conformance',
      {
        work: tool({
          description: 'Build a report',
          inputSchema: z.object({}),
          execute: () => {
            process.stdout.write('executing\n')
            // SIGKILL bypasses signal handlers; this real process wait stays in flight at the crash.
            return NodeEvents.EventEmitter.once(process, 'SIGTERM')
          },
        }),
      },
      { replay: { work: policy } },
    ),
  )
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(file),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(BACKGROUND_CONTEXT)),
  )
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(BACKGROUND_CONTEXT)),
  )
  const root = yield* Effect.promise(() =>
    harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  // The crashed host admits natively: loading respond/history/stream modules adds startup work but
  // cannot change this replay-policy proof. The bridged registration and durable intent are retained.
  yield* Effect.promise(() =>
    root.submit(
      { type: 'input', content: 'Build a report', requestId: 'crash' },
      BACKGROUND_CONTEXT,
    ),
  )
  return yield* Effect.never
})
await runForPi(Effect.scoped(main()), undefined)
