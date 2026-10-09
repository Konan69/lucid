import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, watchEvents } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { Effect, Option } from 'effect'
import { z } from 'zod'
import * as Core from '../core.ts'
import { streamRun, toolsExtension, waiting } from '../main.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { postgresFixture } from './testing.ts'

const context = BACKGROUND_CONTEXT
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])

/** Real PostgreSQL and Pi own every record. The fixture registers database
 * cleanup before opening; Effect scopes close each Harness before reopening. */
const host = Effect.fn('Test.timingHost')(function* () {
  const fixture = postgresFixture(Option.getOrThrow(testUrl))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    yield* Effect.promise(() =>
      toolsExtension(
        'timing',
        {
          ask: tool({ inputSchema: z.object({}) }),
        },
        { answers: { ask: 'later' } },
      ),
    ),
  )
  const open = Effect.fn('Test.openTimingHost')(function* () {
    const storage = yield* Effect.promise(() => fixture.open())
    return yield* Effect.acquireRelease(
      Effect.promise(() => Harness.open(storage, { models, registry, now: () => 123456 }, context)),
      (harness) => Effect.promise(() => harness.close(context)),
    )
  })
  return { fixture, faux, open }
})

describe.skipIf(Option.isNone(testUrl))('PostgreSQL task timing', () => {
  /** Pi 1.1.0 CHANGELOG Added (#10549): exact Session wall-clock stamps survive
   * terminal settlement and reopening. A real legacy JSON fixture lacks both keys. */
  it.live.each([false, true])('exposes task lifecycle after reopen (legacy=%s)', (legacy) =>
    Effect.gen(function* () {
      const setup = yield* host()
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* setup.open()
          const root = yield* Effect.promise(() =>
            harness.root(context, {
              agent: { model: { provider: 'faux', modelId: 'faux-1' } },
            }),
          )
          setup.faux.setResponses([
            fauxAssistantMessage([fauxToolCall('ask', {}, { id: 'ask' })], {
              stopReason: 'toolUse',
            }),
            fauxAssistantMessage('Continuing.'),
          ])
          const streamed = yield* consumeReadable(
            yield* Effect.promise(() =>
              streamRun(
                harness,
                {
                  conversationId: root.id,
                  content: 'Ask later',
                  requestId: 'timing',
                },
                context,
              ),
            ),
            Option.none(),
          )
          yield* Effect.promise(() => root.waitForIdle(context))
          const core = yield* Core.waiting(harness, root.id, context)
          const promise = yield* Effect.promise(() => waiting(harness, root.id, context))
          expect(core).toHaveLength(1)
          expect(promise).toHaveLength(1)
          expect(core[0]).toMatchObject({
            startedAt: Option.some(123456),
            endedAt: Option.some(123456),
          })
          expect(promise[0]).toMatchObject({ startedAt: 123456, endedAt: 123456 })
          const raw = yield* Effect.promise(() =>
            root.entries({ order: 'ascending' }, 100, undefined, context),
          )
          const assistant = raw.items.find((entry) => entry.kind === 'pi.assistant')
          if (assistant === undefined || assistant.byTaskId === undefined)
            throw new Error('Expected generation task attribution')
          const generationId = assistant.byTaskId
          const task = yield* Effect.promise(() => harness.getTask(generationId, context))
          if (task === undefined) throw new Error('Expected persisted generation')
          const watch = yield* Effect.promise(() => watchEvents(harness, root.id, context))
          yield* Effect.promise(() => watch.stop())
          const rebuilt = Core.replayAfter(
            {
              ...watch.snapshot,
              messageId: Option.some(streamed.message.id),
              taskId: Option.some(task.id),
              timing: Core.TaskTiming.make({
                startedAt: Option.fromNullishOr(task.startedAt),
                endedAt: Option.fromNullishOr(task.endedAt),
              }),
            },
            new Set(['ask']),
          )
          expect(Option.getOrThrow(rebuilt).step.state).toMatchObject({
            startedAt: Option.some(123456),
            endedAt: Option.some(123456),
            taskId: Option.some(task.id),
          })
          return {
            conversationId: root.id,
            messageId: streamed.message.id,
            taskIds: [task.id],
            holds: core,
            promise,
          }
        }),
      )
      if (legacy) {
        // Before 1.1.0, the same complete task row had no lifecycle fields. Remove
        // only those JSON keys; identity, state, memo and indexed columns stay exact.
        yield* Effect.promise(() =>
          setup.fixture.pool.query(
            `UPDATE "${setup.fixture.schema}".tasks SET record = (record::jsonb - 'startedAt' - 'endedAt')::text`,
          ),
        )
      }
      const reopened = yield* setup.open()
      const core = yield* Core.waiting(reopened, saved.conversationId, context)
      const promise = yield* Effect.promise(() => waiting(reopened, saved.conversationId, context))
      const taskId = saved.taskIds[0]
      if (taskId === undefined) throw new Error('Expected generation id')
      const record = yield* Effect.promise(() => reopened.getTask(taskId, context))
      if (record === undefined) throw new Error('Expected persisted generation row')
      const watch = yield* Effect.promise(() =>
        watchEvents(reopened, saved.conversationId, context),
      )
      yield* Effect.promise(() => watch.stop())
      const rebuilt = Core.replayAfter(
        {
          ...watch.snapshot,
          messageId: Option.some(saved.messageId),
          taskId: Option.some(taskId),
          timing: Core.TaskTiming.make({
            startedAt: Option.fromNullishOr(record.startedAt),
            endedAt: Option.fromNullishOr(record.endedAt),
          }),
        },
        new Set(['ask']),
      )
      expect(Option.getOrThrow(rebuilt).step.state).toMatchObject({
        startedAt: legacy ? Option.none() : Option.some(123456),
        endedAt: legacy ? Option.none() : Option.some(123456),
      })
      if (legacy) {
        expect(core[0]).toMatchObject({ startedAt: Option.none(), endedAt: Option.none() })
        expect(promise[0]).not.toHaveProperty('startedAt')
        expect(promise[0]).not.toHaveProperty('endedAt')
        expect(record).not.toHaveProperty('startedAt')
        expect(record).not.toHaveProperty('endedAt')
      } else {
        expect(core).toEqual(saved.holds)
        expect(promise).toEqual(saved.promise)
      }
    }),
  )
})
