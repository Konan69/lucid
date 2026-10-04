import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { PersonId, RunState, ThreadId } from '@vivid/contracts'
import {
  ThreadTitleHistoryUnavailable,
  ThreadTitleModelUnavailable,
  ThreadTitleOutputInvalid,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Result, Schema, Stream } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, type Topic } from '../live/changes.ts'
import { ProviderMalformed } from '../memory/embeddings.ts'
import { silentLearningLayer } from '../memory/learn.ts'
import { Completion, MemoryModel } from '../memory/model.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Admission, Runtime, Settlement } from '../runtime/client.ts'
import { submissionId } from '../runtime/identity.ts'
import { findThread } from './access.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { conversationLayer } from './delivery.ts'
import { ThreadTitles, threadTitlesLayer } from './generation.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer } from './runs.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import { threads } from './tables.ts'

const databaseLayer = Layer.mergeAll(runStoreLayer, threadStoreLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

/** Own rows and cleanup before any write; external history, settlement and model are controllable typed seams. */
const harness = Effect.fn('ThreadTitles.test.harness')(function* () {
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
  yield* store.ensure({ id: threadId, title: 'Please plan a holiday', personId, companyId: null })
  const settlement = yield* Deferred.make<Settlement>()
  const completion = yield* Deferred.make<Completion, ProviderMalformed>()
  const requests = yield* Queue.unbounded<Parameters<MemoryModel['Service']['complete']>[0]>()
  const finished = yield* Deferred.make<void>()
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
  const published = yield* Ref.make<
    ReadonlyArray<{ title: string; source: string; topics: ReadonlyArray<Topic> }>
  >([])
  const model = MemoryModel.of({
    complete: (input) =>
      Queue.offer(requests, input).pipe(Effect.andThen(Deferred.await(completion))),
  })
  const runtime = Runtime.of({
    admit: (input) =>
      Effect.succeed(
        Admission.make({
          runId: submissionId(input.threadId, input.idempotencyKey),
          offset: '1',
          incarnation: 'test',
          repeated: false,
        }),
      ),
    settled: () => Deferred.await(settlement),
    stop: () => Effect.succeed(false),
    read: () =>
      Ref.get(messages).pipe(
        Effect.map((history) =>
          HttpClientResponse.fromWeb(
            HttpClientRequest.get('http://runtime.test'),
            new Response(JSON.stringify({ v: 1, messages: history, settlements: [] }), {
              headers: { 'content-type': 'application/json' },
            }),
          ),
        ),
      ),
  })
  const changes = Changes.of({
    publish: (topics) =>
      database.run(database.select().from(threads).where(eq(threads.id, threadId))).pipe(
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.void
            : Ref.update(published, (events) => [
                ...events,
                { title: row.title, source: row.titleSource, topics },
              ]),
        ),
        Effect.catch(() => Effect.sync(() => expect.fail('Publication fixture failed'))),
      ),
    subscribe: () => Effect.succeed(Stream.never),
  })
  const services = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(ThreadStore, store),
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
      titles.afterRun(id).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
  })
  const conversationContext = yield* Layer.build(
    conversationLayer.pipe(
      Layer.provide(services),
      Layer.provide(Layer.succeed(ThreadTitles, observed)),
    ),
  )
  const conversation = yield* Conversation.pipe(Effect.provideContext(conversationContext))
  /** Read through the production Thread decoder for assertions and regeneration snapshots. */
  const stored = Effect.fn('ThreadTitles.test.stored')(function* () {
    const found = yield* findThread(threadId)
    if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Thread missing'))
    return found.value
  })()
  const start = () =>
    conversation.admit({
      threadId,
      personId,
      speaker: DeliverySpeaker.cases.Acting.make({}),
      message: DeliveryMessage.cases.Said.make({ body: 'Please plan a holiday', attachments: [] }),
      origin: StoredRunOrigin.cases.Message.make({}),
      idempotencyKey: 'title',
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
    published,
  }
})

/** Exercise production observation, SQL source guards and publication with a deliberate model Layer. */
describe.skipIf(!testDatabaseConfigured)('Thread title generation', () => {
  it.effect('settles a Run before a blocked title model, then replaces Seed and publishes', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const admitted = yield* test.start()
      yield* Deferred.succeed(
        test.settlement,
        Settlement.cases.Completed.make({ reply: 'Florence could work.' }),
      )
      const input = yield* Queue.take(test.requests)
      expect(input.prompt).toContain('USER:\nPlease plan a holiday in Italy')
      expect((yield* (yield* RunStore).list(test.threadId))[0]).toMatchObject({
        id: admitted.runId,
        state: RunState.cases.Completed.make({ finishedAt: 0 }),
      })
      yield* Deferred.succeed(
        test.completion,
        Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
      )
      yield* Deferred.await(test.finished)
      expect(yield* test.stored).toMatchObject({
        title: 'Plan an Italian holiday',
        titleSource: 'Generated',
      })
      expect(yield* Ref.get(test.published)).toContainEqual({
        title: 'Plan an Italian holiday',
        source: 'Generated',
        topics: [`t:${test.threadId}`, `p:${test.personId}`],
      })
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('leaves a Person title alone after a finished Run', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* test.store.patch(test.personId, test.threadId, { title: 'My holiday' })
      yield* test.start()
      yield* Deferred.succeed(test.settlement, Settlement.cases.Completed.make({ reply: 'Done' }))
      yield* Deferred.await(test.finished)
      expect(yield* test.stored).toMatchObject({ title: 'My holiday', titleSource: 'Person' })
      expect(yield* Queue.size(test.requests)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('keeps title and completed Run on model failure', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* test.start()
      yield* Deferred.succeed(test.settlement, Settlement.cases.Completed.make({ reply: 'Done' }))
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
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('waits for a Person message in a server-opened Thread', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* Ref.set(test.messages, [
        {
          role: 'assistant',
          purpose: 'assistant',
          parts: [{ type: 'text', text: 'Welcome', state: 'done' }],
        },
      ])
      yield* test.titles.afterRun(test.threadId)
      expect(yield* Queue.size(test.requests)).toBe(0)
      expect((yield* test.stored).titleSource).toBe('Seed')
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('regenerates a Person title when explicitly asked', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* test.store.patch(test.personId, test.threadId, { title: 'My holiday' })
      const fiber = yield* test.titles
        .regenerate(yield* test.stored, test.personId)
        .pipe(Effect.forkScoped)
      const input = yield* Queue.take(test.requests)
      expect(input.prompt).toContain('The previous title was "My holiday"')
      expect(input.prompt).toContain('meaningfully improved title')
      yield* Deferred.succeed(
        test.completion,
        Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
      )
      expect(yield* Fiber.join(fiber)).toBe('Explore Florence on holiday')
      expect((yield* test.stored).titleSource).toBe('Generated')
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('drops a regeneration superseded by a Person rename', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const fiber = yield* test.titles
        .regenerate(yield* test.stored, test.personId)
        .pipe(Effect.forkScoped)
      yield* Queue.take(test.requests)
      yield* test.store.patch(test.personId, test.threadId, { title: 'Keep this title' })
      yield* Deferred.succeed(
        test.completion,
        Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
      )
      expect(yield* Fiber.join(fiber)).toBe('Keep this title')
      expect((yield* test.stored).titleSource).toBe('Person')
      expect(yield* Ref.get(test.published)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('protects a Person rename while automatic generation is in flight', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const fiber = yield* test.titles.afterRun(test.threadId).pipe(Effect.forkScoped)
      yield* Queue.take(test.requests)
      yield* test.store.patch(test.personId, test.threadId, { title: 'Person chose this' })
      yield* Deferred.succeed(
        test.completion,
        Completion.cases.Finished.make({ text: '{"title":"Explore Florence on holiday"}' }),
      )
      yield* Fiber.join(fiber)
      expect(yield* test.stored).toMatchObject({
        title: 'Person chose this',
        titleSource: 'Person',
      })
      expect(yield* Ref.get(test.published)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('uses shared Person messages and omits scheduled signals and system text', () =>
    Effect.gen(function* () {
      const test = yield* harness()
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
      expect(request.prompt).toContain('USER:\nPlan a holiday in Italy')
      expect(request.prompt).not.toContain('Scheduled instructions')
      yield* Deferred.succeed(
        test.completion,
        Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
      )
      yield* Fiber.join(fiber)
      expect((yield* test.stored).titleSource).toBe('Generated')
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('returns typed model failure and keeps the title on regeneration', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* Deferred.fail(test.completion, ProviderMalformed.make({ operation: 'title' }))
      const result = yield* test.titles
        .regenerate(yield* test.stored, test.personId)
        .pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure).toEqual(
        ThreadTitleModelUnavailable.make({ thread: test.threadId }),
      )
      expect((yield* test.stored).title).toBe('Please plan a holiday')
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('returns typed history failure and automatic naming leaves Seed unchanged', () =>
    Effect.gen(function* () {
      const test = yield* harness()
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
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('rejects extra output keys without changing the title', () =>
    Effect.gen(function* () {
      const test = yield* harness()
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
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )
})
