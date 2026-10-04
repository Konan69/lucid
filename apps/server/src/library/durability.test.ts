import * as NodeFS from 'node:fs'
import * as NodeWorkerThreads from 'node:worker_threads'
import { layer as pgClientLayer, PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  Cause,
  Clock,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { DatabaseFailure, LibraryItemId, PersonId } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { postgresCodecs } from '../database/codecs.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { workLayer } from '../database/work.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic } from '../live/changes.ts'
import {
  EXTRACTION_DEADLINE,
  ExtractionFaulted,
  ExtractionUnavailable,
  extractOn,
  extractPdf,
} from './extraction.ts'
import { fixture, pendingWork, storedWork } from './fixtures.ts'
import { Fixture } from './fixtures/mode.ts'
import { digestBytes, ingestOwed } from './ingest.ts'
import { ingestionOperations, libraryIngestion } from './ingestion.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'
import { takeIngestion } from './worker.ts'

/** Real queue, store and LISTEN authority all use one disposable database client. */
const processLayer = Layer.mergeAll(libraryStoreLayer, changesLayer).pipe(
  Layer.provideMerge(workLayer),
  Layer.provideMerge(testDatabaseLayer),
)

/** Rollback carries its real item identity to observations outside the aborted transaction. */
class IngestionAbandoned extends Schema.TaggedError<IngestionAbandoned>()(
  'IngestionAbandoned',
  { itemId: LibraryItemId },
  { title: 'Library ingestion test abandoned' },
) {}

/** Public queue deliveries spend the budget without changing an SDK-owned row in test setup. */
class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()(
  'DeliveryRefused',
  {},
  { title: 'Library delivery test refused' },
) {}

const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))
const pdfBytes = NodeFS.readFileSync(new URL('./fixtures/readable.pdf', import.meta.url))

/** Receipt ordering proves absence without a sleep: a committed marker ends the channel prefix. */
const announcedBefore = Effect.fn('LibraryDurability.announcedBefore')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
) {
  const marker = [Topic.person(PersonId.make(crypto.randomUUID()))]
  yield* (yield* Database).transaction((transaction) => announce(transaction, marker))
  return yield* Stream.fromQueue(notifications).pipe(
    Stream.takeWhile((notification) => notification.payload !== JSON.stringify(marker)),
    Stream.mapEffect((notification) => decodeTopics(notification.payload)),
    Stream.runCollect,
  )
})

/** Only createItem may offer: each case verifies the product's actual transaction boundary. */
const createItem = Effect.fn('LibraryDurability.createItem')(function* (
  actor: Actor,
  bytes: Uint8Array,
  mimeType: 'text/plain' | 'application/pdf',
) {
  return yield* (yield* LibraryStore).createItem(actor, {
    name: mimeType === 'application/pdf' ? 'Readable.pdf' : 'Readable.txt',
    mimeType,
    size: bytes.byteLength,
    folderId: null,
    shelf: 'Mine',
    bytes,
    sha256: digestBytes(bytes),
  })
})

/** The real handler receives the SDK's public 1-based attempt metadata, rc.116 PQ:104-108. */
const delivery = Effect.fn('LibraryDurability.delivery')(function* (extract: typeof extractPdf) {
  const queue = yield* libraryIngestion(Schedule.forever)
  return yield* takeIngestion(queue, ingestOwed(ingestionOperations(yield* Database), extract))
})

/** Every invocation records its own native exit, including cancellation of a blocked handler. */
const observed = (input: typeof Fixture.Type) => {
  const exited = Deferred.makeUnsafe<void>()
  const spawned = Deferred.makeUnsafe<NodeWorkerThreads.Worker>()
  const spawn = () => {
    const thread = new NodeWorkerThreads.Worker(new URL('./fixtures/main.ts', import.meta.url), {
      workerData: input,
    })
    thread.once('exit', () => Deferred.doneUnsafe(exited, Effect.void))
    Deferred.doneUnsafe(spawned, Effect.succeed(thread))
    return thread
  }
  return { spawn, exited, spawned }
}

/** Atomics acknowledges handler entry; racing the fiber makes an early thread failure visible. */
const entered = Effect.fn('LibraryDurability.entered')((flag: Int32Array) => {
  const receipt = Atomics.waitAsync(flag, 0, 0)
  if (!receipt.async) return Effect.void
  return Effect.tryPromise({
    try: () => receipt.value,
    catch: () => new ExtractionUnavailable(),
  }).pipe(
    Effect.asVoid,
    Effect.ensuring(
      Effect.sync(() => {
        Atomics.notify(flag, 0)
      }),
    ),
  )
})

/**
 * Register cleanup before the real trigger fault. rc.116 Effect.ts:13054-13058 requires an
 * infallible release; orDie makes a failed test cleanup visible instead of hiding it.
 */
const chunkFault = Effect.fn('LibraryDurability.chunkFault')(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.acquireRelease(Effect.void, () =>
    sql`DROP TRIGGER IF EXISTS vivid_test_chunk_fault ON vivid_library_chunks`.pipe(
      Effect.andThen(sql`DROP FUNCTION IF EXISTS vivid_test_chunk_fault()`),
      Effect.orDie,
    ),
  )
  yield* sql`CREATE FUNCTION vivid_test_chunk_fault() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.text = ''faulted quartz'' THEN RAISE EXCEPTION ''test chunk refusal''; END IF; RETURN NEW; END'`
  yield* sql`CREATE TRIGGER vivid_test_chunk_fault BEFORE INSERT ON vivid_library_chunks
    FOR EACH ROW EXECUTE FUNCTION vivid_test_chunk_fault()`
})

/** A one-connection pool exposes any queue offer that incorrectly checks out another authority. */
const singleConnectionLayer = workLayer.pipe(
  Layer.provideMerge(
    Layer.unwrap(
      Config.Redacted('VIVID_TEST_DATABASE_URL').pipe(
        Effect.map((url) => pgClientLayer({ url, maxConnections: 1, types: postgresCodecs() })),
      ),
    ).pipe(Layer.provide(Layer.succeed(Clock.Clock, Clock.Clock.defaultValue()))),
  ),
)

describe.skipIf(!testDatabaseConfigured)('Native durable Library ingestion', () => {
  layer(processLayer)((it) => {
    /** Q1: aborted bytes, offer and notice vanish together; the next real delivery completes. */
    it.effect('Q1 rolls back create, offer and notice together', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const database = yield* Database
        const store = yield* LibraryStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* database
          .transaction(() =>
            Effect.gen(function* () {
              const item = yield* createItem(
                owner.actor,
                new TextEncoder().encode('abandoned quartz'),
                'text/plain',
              )
              return yield* Effect.fail(new IngestionAbandoned({ itemId: item.document.id }))
            }),
          )
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(IngestionAbandoned)
        if (!(failure instanceof IngestionAbandoned))
          return yield* Effect.die('Wrong rollback failure')
        expect(Option.isNone(yield* store.getStoredItem(owner.actor, failure.itemId))).toBe(true)
        expect(yield* storedWork(failure.itemId)).toEqual([])
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('committed sapphire'),
          'text/plain',
        )
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 0 }])
        yield* delivery(extractPdf)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 1 }])
        expect(yield* store.getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'ready' },
        })
        return undefined
      }),
    )

    /** Q2: both transitions reach the real subscriber and the exact stored-owner channel. */
    it.effect('Q2 announces committed create and settlement', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const subscription = yield* (yield* Changes).subscribe([
          Topic.person(owner.actor.person.id),
        ])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('searchable topaz'),
          'text/plain',
        )
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        yield* delivery(extractPdf)
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'ready' },
        })
      }),
    )

    /** Q3: row-qualified locking makes a lost acknowledgement and competing settlers idempotent. */
    it.effect('Q3 settles once under redelivery and concurrency', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const store = yield* LibraryStore
        const ingest = ingestOwed(ingestionOperations(yield* Database), extractPdf)
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('idempotent emerald'),
          'text/plain',
        )
        yield* delivery(extractPdf)
        const settled = yield* store.getItem(owner.actor, item.document.id)
        yield* ingest(item.document.id, 2)
        expect(yield* store.getItem(owner.actor, item.document.id)).toEqual(settled)
        const next = yield* createItem(
          owner.actor,
          new TextEncoder().encode('competing ruby'),
          'text/plain',
        )
        yield* Effect.all([ingest(next.document.id, 1), ingest(next.document.id, 1)], {
          concurrency: 2,
        })
        expect(yield* store.getItem(owner.actor, next.document.id)).toMatchObject({
          value: { status: 'ready', chunkCount: 1 },
        })
        yield* delivery(extractPdf)
      }),
    )

    /** Q4: deletion ends product ownership of the obligation, so the native delivery succeeds. */
    it.effect('Q4 completes removed item obligations', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('removed garnet'),
          'text/plain',
        )
        yield* (yield* LibraryStore).removeItem(owner.actor, item.document.id)
        yield* delivery(extractPdf)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 1 }])
      }),
    )

    /** Q5: unreadable content settles as a visible product failure without spending retries. */
    it.effect('Q5 settles whitespace content as failed', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode(' \n\t '),
          'text/plain',
        )
        yield* delivery(extractPdf)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: {
            status: 'failed',
            error: 'No readable text was found in this document',
          },
        })
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 1 }])
      }),
    )

    /** Q6: a real SQL trigger faults settlement twice; clearing it repays the same obligation. */
    it.effect('Q6 redelivers typed database failures', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('faulted quartz'),
          'text/plain',
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* chunkFault()
            for (const attempt of [1, 2]) {
              expect(yield* delivery(extractPdf).pipe(Effect.flip)).toBeInstanceOf(DatabaseFailure)
              expect(yield* storedWork(item.document.id)).toEqual([
                { state: 'pending', attempts: attempt },
              ])
              expect(
                yield* (yield* LibraryStore).getItem(owner.actor, item.document.id),
              ).toMatchObject({ value: { status: 'processing' } })
            }
          }),
        )
        yield* delivery(extractPdf)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 3 }])
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'ready' },
        })
      }),
    )

    /** Q7: an exiting real extraction thread is infrastructure failure, not a failed file. */
    it.effect('Q7 retains an unavailable extraction obligation', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const owned = observed(Fixture.cases.exit.make({}))
        expect(
          yield* delivery(extractOn(owned.spawn, EXTRACTION_DEADLINE)).pipe(Effect.flip),
        ).toBeInstanceOf(ExtractionUnavailable)
        expect(yield* Deferred.isDone(owned.spawned)).toBe(true)
        yield* Deferred.await(owned.exited)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 1 }])
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        yield* delivery(extractPdf)
      }),
    )

    /** Q8: native Defect replies remain dies; SDK PQ:1746-1755 redelivers without swallowing. */
    it.effect('Q8 redelivers a real extraction defect', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const owned = observed(Fixture.cases.defect.make({}))
        const exit = yield* Effect.exit(delivery(extractOn(owned.spawn, EXTRACTION_DEADLINE)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(Cause.hasFails(exit.cause)).toBe(false)
        }
        expect(yield* Deferred.isDone(owned.spawned)).toBe(true)
        yield* Deferred.await(owned.exited)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 1 }])
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        yield* delivery(extractPdf)
      }),
    )

    /** Q9: cancellation awaits native exit and returns the claim attempt, PQ:1442-1451. */
    it.effect('Q9 releases cancelled extraction without spending an attempt', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
        const owned = observed(Fixture.cases.spin.make({ flag: flag.buffer }))
        const fiber = yield* delivery(extractOn(owned.spawn, EXTRACTION_DEADLINE)).pipe(
          Effect.forkScoped,
        )
        yield* Effect.raceFirst(entered(flag), Fiber.join(fiber))
        expect(Atomics.load(flag, 0)).toBe(1)
        yield* Fiber.interrupt(fiber)
        yield* Deferred.await(owned.exited)
        expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 0 }])
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        const queue = yield* libraryIngestion(Schedule.forever)
        const ingest = ingestOwed(ingestionOperations(yield* Database), extractPdf)
        expect(
          yield* queue.take((job, metadata) =>
            ingest(job.itemId, metadata.attempts).pipe(Effect.as(metadata.attempts)),
          ),
        ).toBe(1)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'ready' },
        })
      }),
    )

    /** Q10: attempt 9 settles exhaustion before reading even healthy bytes; notice is atomic. */
    it.effect('Q10 exposes exhaustion after eight failed deliveries', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(
          owner.actor,
          new TextEncoder().encode('readable exhausted opal'),
          'text/plain',
        )
        const queue = yield* libraryIngestion(Schedule.forever)
        for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8]) {
          expect(
            yield* queue.take(() => Effect.fail(new DeliveryRefused())).pipe(Effect.flip),
          ).toBeInstanceOf(DeliveryRefused)
          expect(yield* storedWork(item.document.id)).toEqual([
            { state: 'pending', attempts: attempt },
          ])
        }
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        const subscription = yield* (yield* Changes).subscribe([
          Topic.person(owner.actor.person.id),
        ])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* delivery(extractPdf)
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: {
            status: 'failed',
            error: 'Vivid could not read this file. Remove it and upload it again.',
            chunkCount: 0,
          },
        })
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 9 }])
      }),
    )

    /** X4: actual unpdf password rejection settles and announces, then PQ:1739 completes delivery 1. */
    it.effect('X4 settles a locked PDF on its first real delivery', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const bytes = NodeFS.readFileSync(new URL('./fixtures/locked.pdf', import.meta.url))
        const item = yield* createItem(owner.actor, bytes, 'application/pdf')
        const subscription = yield* (yield* Changes).subscribe([
          Topic.person(owner.actor.person.id),
        ])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* delivery(extractPdf)
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'failed', error: 'This PDF is locked with a password', chunkCount: 0 },
        })
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 1 }])
      }),
    )

    /** X5: seven public refusals spend attempts; a real faulted RPC at 8 settles and announces. */
    it.effect('X5 settles a parser fault at attempt eight', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const queue = yield* libraryIngestion(Schedule.forever)
        for (const attempt of [1, 2, 3, 4, 5, 6, 7]) {
          expect(
            yield* queue.take(() => Effect.fail(new DeliveryRefused())).pipe(Effect.flip),
          ).toBeInstanceOf(DeliveryRefused)
          expect(yield* storedWork(item.document.id)).toEqual([
            { state: 'pending', attempts: attempt },
          ])
        }
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        const subscription = yield* (yield* Changes).subscribe([
          Topic.person(owner.actor.person.id),
        ])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const owned = observed(Fixture.cases.faulted.make({}))
        yield* delivery(extractOn(owned.spawn, EXTRACTION_DEADLINE))
        yield* Deferred.await(owned.exited)
        expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(owner.actor.person.id)],
        ])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'failed', error: 'PDF text extraction failed', chunkCount: 0 },
        })
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'completed', attempts: 8 }])
      }),
    )

    /** X5: a real typed parser fault at 1 remains processing/pending, PQ:1749-1755; no settle notice. */
    it.effect('X5 retains a parser fault at attempt one', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const owned = observed(Fixture.cases.faulted.make({}))
        expect(
          yield* delivery(extractOn(owned.spawn, EXTRACTION_DEADLINE)).pipe(Effect.flip),
        ).toEqual(new ExtractionFaulted())
        yield* Deferred.await(owned.exited)
        expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
        expect(yield* announcedBefore(notifications)).toEqual([])
        expect(yield* (yield* LibraryStore).getItem(owner.actor, item.document.id)).toMatchObject({
          value: { status: 'processing' },
        })
        expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 1 }])
        // Repay through the public delivery seam so the next case's pending precondition stays honest.
        yield* delivery(extractPdf)
      }),
    )

    /** T8: the configured workLayer offer joins the sole SQL connection and rolls back with it. */
    it.effect('T8 offers inside a transaction with a one-connection pool', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const suiteClient = yield* SqlClient.SqlClient
        const context = yield* Layer.build(Layer.fresh(singleConnectionLayer))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(sql).not.toBe(suiteClient)
          const queue = yield* libraryIngestion(Schedule.forever)
          const itemId = LibraryItemId.make(crypto.randomUUID())
          yield* sql
            .withTransaction(
              queue
                .offer({ itemId }, { id: itemId })
                .pipe(Effect.andThen(Effect.fail(new IngestionAbandoned({ itemId })))),
            )
            .pipe(Effect.catchTag('IngestionAbandoned', Effect.succeed))
          expect(yield* storedWork(itemId)).toEqual([])
          expect(yield* sql.withTransaction(queue.offer({ itemId }, { id: itemId }))).toBe(itemId)
          expect(yield* queue.take((job) => Effect.succeed(job.itemId))).toBe(itemId)
        }).pipe(Effect.provide(context))
      }),
    )
  })
})
