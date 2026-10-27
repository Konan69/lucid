import { historyMessage } from '../approvals/testing.ts'
import { silentChannelRepliesLayer } from '../channels/replies.ts'
import { PgClient } from '@effect/sql-pg/PgClient'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import {
  Person,
  PersonId,
  RunId,
  RuntimeSubmissionId,
  RunState,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import {
  ThreadTitleHistoryUnavailable,
  ThreadTitleModelUnavailable,
  ThreadTitleOutputInvalid,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, Topic } from '../live/changes.ts'
import { ProviderMalformed } from '../memory/embeddings.ts'
import { silentLearningLayer } from '../memory/testing.ts'
import { Completion, MemoryModel } from '../memory/model.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Admission, Runtime, Settlement } from '../runtime/client.ts'
import { deliveryRunId } from '../threads/key.ts'
import { findThread } from './access.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { conversationLayer } from './delivery.ts'
import { ThreadTitles, threadTitlesLayer } from './generation.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer } from './runs.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import type { TitleSource } from './title.ts'
import { threads } from './tables.ts'

const databaseLayer = Layer.mergeAll(runStoreLayer, threadStoreLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

/** Own rows and cleanup before any write; external history, settlement and model are controllable typed seams. */
const harness = Effect.fn('ThreadTitles.test.harness')(function* (
  title: string,
  titleSource: TitleSource,
) {
  const database = yield* Database
  const store = yield* ThreadStore
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
      Effect.andThen(
        database.run(database.delete(personTable).where(eq(personTable.id, personId))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Title cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Ada', email: `${personId}@example.test` }),
  )
  yield* store.create(
    {
      person: Person.make({
        id: personId,
        name: 'Ada',
        email: `${personId}@example.test`,
        image: null,
      }),
      workspace: Workspace.cases.Personal.make({}),
      by: 'person',
      threadId: Option.none(),
    },
    { id: threadId, title, projectId: null },
  )
  // Assigned-title cases need their original provenance before the generation under test starts.
  yield* database.run(database.update(threads).set({ titleSource }).where(eq(threads.id, threadId)))
  const settlement = yield* Deferred.make<Settlement>()
  const completion = yield* Deferred.make<Completion, ProviderMalformed>()
  const requests = yield* Queue.unbounded<Parameters<MemoryModel['Service']['complete']>[0]>()
  const finished = yield* Deferred.make<void>()
  const finishedRuns = yield* Queue.unbounded<void>()
  const generatedWrites = yield* Ref.make(0)
  const modelFinished = yield* Deferred.make<void>()
  // Observe accepted writes while retaining the real store's atomic SQL guard.
  const observedStore = ThreadStore.of({
    ...store,
    generatedTitle: (id, next, previous) =>
      store
        .generatedTitle(id, next, previous)
        .pipe(
          Effect.tap((written) =>
            written ? Ref.update(generatedWrites, (count) => count + 1) : Effect.void,
          ),
        ),
  })
  const messages = yield* Ref.make<ReadonlyArray<Schema.Json>>([
    {
      role: 'user',
      purpose: 'user',
      parts: [{ type: 'text', text: 'Please plan a holiday in Italy', state: 'done' }],
    },
    {
      role: 'assistant',
      purpose: 'assistant',
      parts: [{ type: 'text', text: 'We can explore Florence.', state: 'done' }],
    },
  ])
  const model = MemoryModel.of({
    complete: (input) =>
      Queue.offer(requests, input).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.ensuring(Deferred.succeed(modelFinished, undefined)),
      ),
  })
  const runtime = Runtime.of({
    admit: (input) =>
      Effect.succeed(
        Admission.make({
          runId: deliveryRunId(input.threadId, input.idempotencyKey),
          submissionId: RuntimeSubmissionId.make(input.turn),
          repeated: false,
        }),
      ),
    settled: () => Deferred.await(settlement),
    stop: () => Effect.succeed(false),
    watch: () => Stream.never,
    read: () =>
      Ref.get(messages).pipe(
        Effect.map((history) =>
          HttpClientResponse.fromWeb(
            HttpClientRequest.get('http://runtime.test'),
            new Response(
              JSON.stringify({
                messages: history.map(historyMessage),
                settlements: [],
                working: false,
                queued: 0,
              }),
              {
                headers: { 'content-type': 'application/json' },
              },
            ),
          ),
        ),
      ),
  })
  const changes = Changes.of({
    publish: () => Effect.void,
    subscribe: () => Effect.succeed(Stream.never),
  })
  const services = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(ThreadStore, observedStore),
    Layer.succeed(RunStore, yield* RunStore),
    Layer.succeed(Runtime, runtime),
    Layer.succeed(MemoryModel, model),
    Layer.succeed(Changes, changes),
    silentLearningLayer,
    Layer.succeed(Notifier, { notify: () => Effect.void }),
    Layer.mock(Presence, { watching: () => Effect.succeed(true) }),
  )
  const titleContext = yield* Layer.build(threadTitlesLayer.pipe(Layer.provide(services)))
  const titles = yield* ThreadTitles.pipe(Effect.provideContext(titleContext))
  // An observed completion receipt lets tests await warning-only failures without sleeps or polling.
  const observed = ThreadTitles.of({
    ...titles,
    afterRun: (id) =>
      titles
        .afterRun(id)
        .pipe(
          Effect.ensuring(
            Deferred.succeed(finished, undefined).pipe(
              Effect.andThen(Queue.offer(finishedRuns, undefined)),
            ),
          ),
        ),
  })
  const conversationContext = yield* Layer.build(
    conversationLayer.pipe(
      Layer.provide(silentChannelRepliesLayer),
      Layer.provide(services),
      Layer.provide(Layer.succeed(ThreadTitles, observed)),
    ),
  )
  const conversation = yield* Conversation.pipe(Effect.provideContext(conversationContext))
  /** Read through the production Thread decoder for assertions and regeneration snapshots. */
  const stored = Effect.gen(function* () {
    const found = yield* findThread(threadId)
    if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Thread missing'))
    return found.value
  }).pipe(Effect.withSpan('ThreadTitles.test.stored'))
  const start = (idempotencyKey: string) =>
    conversation.admit({
      threadId,
      personId,
      speaker: DeliverySpeaker.cases.Acting.make({}),
      message: DeliveryMessage.cases.Said.make({ body: 'Please plan a holiday', attachments: [] }),
      origin: StoredRunOrigin.cases.Message.make({}),
      idempotencyKey,
    })
  return {
    personId,
    threadId,
    store,
    titles,
    start,
    stored,
    completion,
    requests,
    settlement,
    finished,
    messages,
    finishedRuns,
    generatedWrites,
    modelFinished,
  }
})

const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/** A later committed unique topic proves a superseded generation emitted no SQL announcement. */
const marker = Effect.fn('ThreadTitles.test.marker')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
) {
  const topic = Topic.person(PersonId.make(NodeCrypto.randomUUID()))
  yield* (yield* Database).transaction((tx) => announce(tx, [topic]))
  expect(yield* decodeTopics((yield* Queue.take(notifications)).payload)).toEqual([topic])
})

/** Exercise production observation, SQL source guards and publication with a deliberate model Layer. */
layer(databaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Thread title generation', () => {
    layer(databaseLayer)('Clock case 1', (it) => {
      it.effect(
        'settles a Run before a blocked title model, then replaces Seed and publishes',
        () =>
          Effect.gen(function* () {
            const test = yield* harness('Please plan a holiday', 'Seed')
            const admitted = yield* test.start('title')
            yield* Deferred.succeed(
              test.settlement,
              Settlement.cases.Completed.make({
                reply: 'Florence could work.',
                responseId: RunId.make('title-test-response'),
              }),
            )
            const input = yield* Queue.take(test.requests)
            expect(input.content).toEqual({
              conversation:
                'Thread contents:\nUSER:\nPlease plan a holiday in Italy\n\nASSISTANT:\nWe can explore Florence.',
              previousTitle: null,
            })
            expect(input.prompt).not.toContain('Please plan a holiday in Italy')
            expect((yield* (yield* RunStore).list(test.threadId))[0]).toMatchObject({
              id: admitted.runId,
              state: RunState.cases.Completed.make({ finishedAt: 0 }),
            })
            const notifications = yield* (yield* PgClient).listen(CHANNEL)
            yield* Deferred.succeed(
              test.completion,
              Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
            )
            yield* Deferred.await(test.finished)
            expect(yield* test.stored).toMatchObject({
              title: 'Plan an Italian holiday',
              titleSource: 'Generated',
            })
            expect(
              new Set(yield* decodeTopics((yield* Queue.take(notifications)).payload)),
            ).toEqual(new Set([Topic.thread(test.threadId), Topic.person(test.personId)]))
          }).pipe(Effect.scoped),
      )
    })

    it.effect.each(['', '  ', '`"\'`', 'New thread'])(
      'keeps Seed retryable after unusable model title %j',
      (raw) =>
        Effect.gen(function* () {
          const test = yield* harness('Please plan a holiday', 'Seed')
          yield* test.start('title')
          yield* Deferred.succeed(
            test.settlement,
            Settlement.cases.Completed.make({
              reply: 'Done',
              responseId: RunId.make('title-test-response'),
            }),
          )
          yield* Queue.take(test.requests)
          yield* Deferred.succeed(
            test.completion,
            Completion.cases.Finished.make({ text: JSON.stringify({ title: raw }) }),
          )
          yield* Deferred.await(test.finished)
          expect(yield* test.stored).toMatchObject({
            title: 'Please plan a holiday',
            titleSource: 'Seed',
          })
          expect(yield* Ref.get(test.generatedWrites)).toBe(0)
          // A subsequent settled Run can still try the provider because provenance stayed Seed.
          yield* test.titles.afterRun(test.threadId)
          expect(yield* Queue.size(test.requests)).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect.each([['Weekly holiday planning', 'Assigned']] as const)(
      'preserves durable name %s after a Person reply and settled Run',
      ([title, source]) =>
        Effect.gen(function* () {
          const test = yield* harness(title, source)
          yield* test.start('reply')
          yield* Deferred.succeed(
            test.settlement,
            Settlement.cases.Completed.make({
              reply: 'Done',
              responseId: RunId.make('title-test-response'),
            }),
          )
          yield* Deferred.await(test.finished)
          expect(yield* test.stored).toMatchObject({ title, titleSource: source })
          expect(yield* Queue.size(test.requests)).toBe(0)
          expect(yield* Ref.get(test.generatedWrites)).toBe(0)
        }).pipe(Effect.scoped),
    )

    it.effect('accepts one title write when two Runs settle together', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* test.start('first')
        yield* test.start('second')
        yield* Deferred.succeed(
          test.settlement,
          Settlement.cases.Completed.make({
            reply: 'Done',
            responseId: RunId.make('title-test-response'),
          }),
        )
        // Both observers reach the model before either may write, forcing the guarded SQL race.
        yield* Queue.take(test.requests)
        yield* Queue.take(test.requests)
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
        )
        yield* Queue.take(test.finishedRuns)
        yield* Queue.take(test.finishedRuns)
        expect(yield* Ref.get(test.generatedWrites)).toBe(1)
        expect(yield* test.stored).toMatchObject({
          title: 'Plan an Italian holiday',
          titleSource: 'Generated',
        })
        const runs = yield* (yield* RunStore).list(test.threadId)
        expect(runs).toHaveLength(2)
        expect(runs.every((run) => RunState.guards.Completed(run.state))).toBe(true)
      }).pipe(Effect.scoped),
    )

    layer(databaseLayer)('Clock case 2', (it) => {
      it.effect('bounds regeneration with a typed model timeout and interrupts the provider', () =>
        Effect.gen(function* () {
          const test = yield* harness('Please plan a holiday', 'Seed')
          const fiber = yield* test.titles
            .regenerate(yield* test.stored, test.personId)
            .pipe(Effect.result, Effect.forkScoped)
          yield* Queue.take(test.requests)
          yield* TestClock.adjust('29999 millis')
          expect(yield* Deferred.isDone(test.modelFinished)).toBe(false)
          yield* TestClock.adjust('1 millis')
          yield* Deferred.await(test.modelFinished)
          expect(yield* Fiber.join(fiber)).toEqual(
            Result.fail(ThreadTitleModelUnavailable.make({ thread: test.threadId })),
          )
          expect(yield* test.stored).toMatchObject({
            title: 'Please plan a holiday',
            titleSource: 'Seed',
          })
        }).pipe(Effect.scoped),
      )
    })

    layer(databaseLayer)('Clock case 3', (it) => {
      it.effect(
        'bounds background generation while leaving the settled Run complete and Seed retryable',
        () =>
          Effect.gen(function* () {
            const test = yield* harness('Please plan a holiday', 'Seed')
            yield* test.start('title')
            yield* Deferred.succeed(
              test.settlement,
              Settlement.cases.Completed.make({
                reply: 'Done',
                responseId: RunId.make('title-test-response'),
              }),
            )
            yield* Queue.take(test.requests)
            yield* TestClock.adjust('29999 millis')
            expect(yield* Deferred.isDone(test.modelFinished)).toBe(false)
            yield* TestClock.adjust('1 millis')
            yield* Deferred.await(test.modelFinished)
            yield* Deferred.await(test.finished)
            expect(yield* test.stored).toMatchObject({
              title: 'Please plan a holiday',
              titleSource: 'Seed',
            })
            expect(
              (yield* (yield* RunStore).list(test.threadId)).every((run) =>
                RunState.guards.Completed(run.state),
              ),
            ).toBe(true)
            expect(yield* Ref.get(test.generatedWrites)).toBe(0)
          }).pipe(Effect.scoped),
      )
    })

    it.effect('logs a model defect with Thread context without failing the settled Run', () => {
      const logs: unknown[] = []
      const logger = Logger.make((event) => {
        logs.push(event.message)
      })
      return Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* test.start('title')
        yield* Deferred.succeed(
          test.settlement,
          Settlement.cases.Completed.make({
            reply: 'Done',
            responseId: RunId.make('title-test-response'),
          }),
        )
        yield* Queue.take(test.requests)
        yield* Deferred.failCause(test.completion, Cause.die(new Error('Title provider defect')))
        yield* Deferred.await(test.finished)
        expect(logs).toContainEqual([
          'Thread title generation failed',
          { thread: test.threadId, cause: expect.stringContaining('Title provider defect') },
        ])
        expect((yield* test.stored).titleSource).toBe('Seed')
        expect(
          (yield* (yield* RunStore).list(test.threadId)).every((run) =>
            RunState.guards.Completed(run.state),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped, Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    })

    it.effect('leaves a Person title alone after a finished Run', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* test.store.patch(test.personId, test.threadId, { title: 'My holiday' })
        yield* test.start('title')
        yield* Deferred.succeed(
          test.settlement,
          Settlement.cases.Completed.make({
            reply: 'Done',
            responseId: RunId.make('title-test-response'),
          }),
        )
        yield* Deferred.await(test.finished)
        expect(yield* test.stored).toMatchObject({ title: 'My holiday', titleSource: 'Person' })
        expect(yield* Queue.size(test.requests)).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.effect('keeps title and completed Run on model failure', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* test.start('title')
        yield* Deferred.succeed(
          test.settlement,
          Settlement.cases.Completed.make({
            reply: 'Done',
            responseId: RunId.make('title-test-response'),
          }),
        )
        yield* Queue.take(test.requests)
        yield* Deferred.fail(test.completion, ProviderMalformed.make({ operation: 'title' }))
        yield* Deferred.await(test.finished)
        expect(yield* test.stored).toMatchObject({
          title: 'Please plan a holiday',
          titleSource: 'Seed',
        })
        expect(
          (yield* (yield* RunStore).list(test.threadId)).map((run) =>
            RunState.guards.Completed(run.state),
          ),
        ).toEqual([true])
      }).pipe(Effect.scoped),
    )

    it.effect('waits for Person words then keeps Vivid opening context as user data', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Ref.set(test.messages, [
          {
            role: 'assistant',
            purpose: 'assistant',
            parts: [{ type: 'text', text: 'Where should we plan your holiday?', state: 'done' }],
          },
        ])
        yield* test.titles.afterRun(test.threadId)
        expect(yield* Queue.size(test.requests)).toBe(0)
        expect((yield* test.stored).titleSource).toBe('Seed')
        yield* Ref.update(test.messages, (messages) => [
          ...messages,
          {
            role: 'user',
            purpose: 'user',
            parts: [{ type: 'text', text: 'Italy', state: 'done' }],
          },
        ])
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
        )
        yield* test.titles.afterRun(test.threadId)
        const request = yield* Queue.take(test.requests)
        expect(request.content).toEqual({
          conversation:
            'Thread contents:\nASSISTANT:\nWhere should we plan your holiday?\n\nUSER:\nItaly',
          previousTitle: null,
        })
        expect(request.prompt).not.toContain('Where should we plan your holiday?')
        expect((yield* test.stored).titleSource).toBe('Generated')
      }).pipe(Effect.scoped),
    )

    it.effect('regenerates a Person title when explicitly asked', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* test.store.patch(test.personId, test.threadId, { title: 'My holiday' })
        const fiber = yield* test.titles
          .regenerate(yield* test.stored, test.personId)
          .pipe(Effect.forkScoped)
        const input = yield* Queue.take(test.requests)
        expect(input.content).toMatchObject({ previousTitle: 'My holiday' })
        expect(input.prompt).not.toContain('My holiday')
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
        )
        expect(yield* Fiber.join(fiber)).toBe('Explore Florence on holiday')
        expect((yield* test.stored).titleSource).toBe('Generated')
      }).pipe(Effect.scoped),
    )

    it.effect('drops a regeneration superseded by a Person rename', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        const fiber = yield* test.titles
          .regenerate(yield* test.stored, test.personId)
          .pipe(Effect.forkScoped)
        yield* Queue.take(test.requests)
        yield* test.store.patch(test.personId, test.threadId, { title: 'Keep this title' })
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
        )
        expect(yield* Fiber.join(fiber)).toBe('Keep this title')
        expect((yield* test.stored).titleSource).toBe('Person')
        yield* marker(notifications)
      }).pipe(Effect.scoped),
    )

    it.effect('protects a Person rename while automatic generation is in flight', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        const fiber = yield* test.titles.afterRun(test.threadId).pipe(Effect.forkScoped)
        yield* Queue.take(test.requests)
        yield* test.store.patch(test.personId, test.threadId, { title: 'Person chose this' })
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
        )
        yield* Fiber.join(fiber)
        expect(yield* test.stored).toMatchObject({
          title: 'Person chose this',
          titleSource: 'Person',
        })
        yield* marker(notifications)
      }).pipe(Effect.scoped),
    )

    it.effect('uses shared Person messages and omits scheduled signals and system text', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Ref.set(test.messages, [
          {
            role: 'system',
            purpose: 'dispatch',
            signal: { tagName: 'schedule' },
            parts: [{ type: 'text', text: 'Scheduled instructions', state: 'done' }],
          },
          {
            role: 'system',
            purpose: 'dispatch',
            signal: { tagName: 'message', attributes: { from: 'Ada' } },
            parts: [{ type: 'text', text: 'Plan a holiday in Italy', state: 'done' }],
          },
        ])
        const fiber = yield* test.titles.afterRun(test.threadId).pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.requests)
        expect(request.content).toEqual({
          conversation: 'Thread contents:\nUSER:\nPlan a holiday in Italy',
          previousTitle: null,
        })
        expect(JSON.stringify(request.content)).not.toContain('Scheduled instructions')
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
        )
        yield* Fiber.join(fiber)
        expect((yield* test.stored).titleSource).toBe('Generated')
      }).pipe(Effect.scoped),
    )

    // The first Thread is opened by Vivid, and the Person replies only by pressing answers on
    // question cards. Flue records each as an `answer` dispatch, never a `user` message, so
    // without this case the Thread has no Person words and keeps its Seed title forever.
    it.effect('counts a pressed answer as Person words when Vivid opened the Thread', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Ref.set(test.messages, [
          {
            role: 'assistant',
            purpose: 'assistant',
            parts: [{ type: 'text', text: 'What takes most of your day?', state: 'done' }],
          },
          {
            role: 'system',
            purpose: 'dispatch',
            signal: { tagName: 'answer' },
            parts: [{ type: 'text', text: 'Client building work', state: 'done' }],
          },
        ])
        const fiber = yield* test.titles.afterRun(test.threadId).pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.requests)
        expect(request.content).toEqual({
          conversation:
            'Thread contents:\nASSISTANT:\nWhat takes most of your day?\n\nUSER:\nClient building work',
          previousTitle: null,
        })
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Client building work"}' }),
        )
        yield* Fiber.join(fiber)
        expect(yield* test.stored).toMatchObject({
          title: 'Client building work',
          titleSource: 'Generated',
        })
      }).pipe(Effect.scoped),
    )

    it.effect('returns typed model failure and keeps the title on regeneration', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Deferred.fail(test.completion, ProviderMalformed.make({ operation: 'title' }))
        const result = yield* test.titles
          .regenerate(yield* test.stored, test.personId)
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure).toEqual(
          ThreadTitleModelUnavailable.make({ thread: test.threadId }),
        )
        expect((yield* test.stored).title).toBe('Please plan a holiday')
      }).pipe(Effect.scoped),
    )

    it.effect('returns typed history failure and automatic naming leaves Seed unchanged', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Ref.set(test.messages, [{ role: 'invalid', parts: [] }])
        const result = yield* test.titles
          .regenerate(yield* test.stored, test.personId)
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure).toEqual(
          ThreadTitleHistoryUnavailable.make({ thread: test.threadId }),
        )
        yield* test.titles.afterRun(test.threadId)
        expect((yield* test.stored).titleSource).toBe('Seed')
        expect(yield* Queue.size(test.requests)).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.effect('rejects extra output keys without changing the title', () =>
      Effect.gen(function* () {
        const test = yield* harness('Please plan a holiday', 'Seed')
        yield* Deferred.succeed(
          test.completion,
          Completion.cases.Finished.make({ text: '{"title":"Holiday","extra":true}' }),
        )
        const result = yield* test.titles
          .regenerate(yield* test.stored, test.personId)
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure).toEqual(
          ThreadTitleOutputInvalid.make({ thread: test.threadId }),
        )
        expect((yield* test.stored).titleSource).toBe('Seed')
      }).pipe(Effect.scoped),
    )
  })
})
