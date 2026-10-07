import * as NodeFS from 'node:fs'
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
import { SqlError } from 'effect/unstable/sql/SqlError'
import { DatabaseFailure, LibraryItemId, PersonId } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { postgresCodecs } from '../database/codecs.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { WORK_TABLE, workLayer } from '../database/work.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic } from '../live/changes.ts'
import {
  EXTRACTION_HEAP_MB,
  ExtractionLimitExceeded,
  ExtractionFaulted,
  ExtractionUnavailable,
  extractPdf,
} from './extraction.ts'
import { fixture, pendingWork, storedWork } from './fixtures.ts'
import { Fixture } from './fixtures/mode.ts'
import { CRASH_TIMEOUT_MS } from './fixtures/process/mode.ts'
import { GROW_HEAP_MB, nativeLaunch, extractWith, reportRemoved } from './fixtures/launch.ts'
import { digestBytes, ingestOwed } from './ingest.ts'
import { INGESTION_QUEUE_NAME, ingestionOperations, libraryIngestion } from './ingestion.ts'
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

/** Preserve the original SQL failure when P12's infallible finalizer must fail the test as a defect. */
class QueueCleanupFailed extends Schema.TaggedError<QueueCleanupFailed>()(
  'QueueCleanupFailed',
  { operation: Schema.Literal('LibraryDurability.P12.cleanup'), cause: SqlError },
  { title: 'Library ingestion test queue cleanup failed' },
) {}

const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))
const pdfBytes = NodeFS.readFileSync(new URL('./fixtures/readable.pdf', import.meta.url))

/** SQL receipt for ownership, independent of the queue's product-facing state projection. */
const decodeClaims = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ held: Schema.Boolean })),
)

/**
 * Read only this item's SDK claim. rc.116 PersistedQueue.complete clears both ownership columns
 * (PersistedQueue.ts:1409-1417); completed state alone would not prove that release happened.
 */
const storedClaims = Effect.fn('LibraryDurability.storedClaims')(function* (id: LibraryItemId) {
  const sql = yield* SqlClient.SqlClient
  return yield* decodeClaims(
    yield* sql`
      SELECT (acquired_at IS NOT NULL OR acquired_by IS NOT NULL) AS held
      FROM ${sql(WORK_TABLE)} WHERE queue_name = ${INGESTION_QUEUE_NAME} AND id = ${id}
    `,
  )
})

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
              return yield* new IngestionAbandoned({ itemId: item.document.id })
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

    /** Q7: an exiting real extraction process is infrastructure failure, not a failed file. */
    it.effect('Q7 retains an unavailable extraction obligation', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const item = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
        const owned = nativeLaunch(Fixture.cases.exit.make({}), EXTRACTION_HEAP_MB)
        expect(yield* delivery(extractWith(owned.launch)).pipe(Effect.flip)).toBeInstanceOf(
          ExtractionUnavailable,
        )
        expect(yield* Deferred.isDone(owned.reportDir)).toBe(true)
        yield* Deferred.await(owned.ended)
        expect(yield* reportRemoved(owned)).toBe(true)
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
        const owned = nativeLaunch(Fixture.cases.defect.make({}), EXTRACTION_HEAP_MB)
        const exit = yield* Effect.exit(delivery(extractWith(owned.launch)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(Cause.hasFails(exit.cause)).toBe(false)
        }
        expect(yield* Deferred.isDone(owned.reportDir)).toBe(true)
        yield* Deferred.await(owned.ended)
        expect(yield* reportRemoved(owned)).toBe(true)
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
        const owned = nativeLaunch(Fixture.cases.spin.make({}), EXTRACTION_HEAP_MB)
        const fiber = yield* delivery(extractWith(owned.launch)).pipe(Effect.forkScoped)
        expect(yield* Effect.raceFirst(Deferred.await(owned.entered), Fiber.join(fiber))).toBe(true)
        yield* Fiber.interrupt(fiber)
        Exit.match(yield* Fiber.await(fiber), {
          onSuccess: () => expect.unreachable('Cancelled delivery unexpectedly succeeded'),
          onFailure: (cause) => expect(Cause.hasInterruptsOnly(cause)).toBe(true),
        })
        expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGKILL' })
        expect(yield* reportRemoved(owned)).toBe(true)
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

    /**
     * P12 (process-extraction-design-r2 §8): a real 64 MiB heap death goes through the production
     * takeIngestion/ingestOwed consumer over the real persisted queue, not a simulated failure.
     * The typed receipt precedes ingest.ts:88-91's product conversion. Node's native exit and the
     * removed report directory prove release before the same queue consumes its next real PDF.
     * SQL rows prove both acknowledgements and no held claims (rc.116 PQ:1409-1417,1739-1755).
     * Existing VIVID_TEST_DATABASE_URL harness: per-file migrated clone plus per-case cleanup.
     * Root supplies the labeled disposable instance and runs abort cases under its scoped core limit.
     * Use extraction.test.ts's native crash bound: WSL's piped crash handler delays SIGABRT exit
     * beyond the runner default even with core files disabled. Synchronization still uses receipts.
     */
    it.effect(
      'P12 settles heap exhaustion and consumes the next real PDF without a held claim',
      () =>
        Effect.gen(function* () {
          expect(yield* pendingWork()).toEqual([])
          const { owner } = yield* fixture()
          const sql = yield* SqlClient.SqlClient
          /**
           * Intentional cleanup write to the SDK-owned table, limited to this case's Person/items.
           * Register before either offer; LIFO cleanup runs before fixture() removes its Person,
           * keeping the subselect valid even after a failed assertion. rc.116 Effect.addFinalizer
           * requires Effect<void, never, R>; a tagged defect retains the original SqlError and
           * identifies the cleanup operation without adding credentials or connection settings.
           */
          yield* Effect.addFinalizer(() =>
            sql`
            DELETE FROM ${sql(WORK_TABLE)} WHERE queue_name = ${INGESTION_QUEUE_NAME}
            AND id IN (SELECT id FROM vivid_library_documents WHERE person_id = ${owner.actor.person.id})
          `.pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.die(
                  new QueueCleanupFailed({ operation: 'LibraryDurability.P12.cleanup', cause }),
                ),
              ),
            ),
          )
          // A valid trailing PDF comment gives the heap item its own digest; otherwise createItem's
          // real shelf deduplication would make the healthy upload the same already-failed item.
          const heapBytes = new Uint8Array([
            ...pdfBytes,
            ...new TextEncoder().encode('\n% Heap fixture\n'),
          ])
          const failed = yield* createItem(owner.actor, heapBytes, 'application/pdf')
          const healthy = yield* createItem(owner.actor, pdfBytes, 'application/pdf')
          expect(healthy.document.id).not.toBe(failed.document.id)
          const store = yield* LibraryStore
          const queue = yield* libraryIngestion(Schedule.forever)
          const operations = ingestionOperations(yield* Database)
          const owned = nativeLaunch(Fixture.cases.grow.make({}), GROW_HEAP_MB)
          const heapFailure = yield* Deferred.make<ExtractionLimitExceeded>()
          // tapErrorTag preserves the native typed error for the production consumer to handle.
          const extractHeap: typeof extractPdf = (bytes) =>
            extractWith(owned.launch)(bytes).pipe(
              Effect.tapErrorTag('ExtractionLimitExceeded', (failure) =>
                Deferred.succeed(heapFailure, failure),
              ),
            )
          yield* takeIngestion(queue, ingestOwed(operations, extractHeap))
          // Check the receipt is present before awaiting: a missing heap classification fails here
          // immediately rather than turning this behavioral proof into an unbounded receipt wait.
          expect(yield* Deferred.isDone(heapFailure)).toBe(true)
          expect(yield* Deferred.await(heapFailure)).toEqual(
            new ExtractionLimitExceeded({ limit: 'heap' }),
          )
          expect(yield* Deferred.await(owned.entered)).toBe(true)
          expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGABRT' })
          expect(yield* reportRemoved(owned)).toBe(true)
          expect(yield* store.getItem(owner.actor, failed.document.id)).toMatchObject({
            value: { status: 'failed', error: 'This PDF is too large to read', chunkCount: 0 },
          })
          expect(yield* storedWork(failed.document.id)).toEqual([
            { state: 'completed', attempts: 1 },
          ])
          expect(yield* storedClaims(failed.document.id)).toEqual([{ held: false }])
          expect(yield* storedWork(healthy.document.id)).toEqual([
            { state: 'pending', attempts: 0 },
          ])
          yield* takeIngestion(queue, ingestOwed(operations, extractPdf))
          expect(yield* store.getItem(owner.actor, healthy.document.id)).toMatchObject({
            value: {
              status: 'ready',
              error: null,
              chunkCount: 1,
              preview: 'Vivid extraction fixture',
            },
          })
          expect(yield* storedWork(healthy.document.id)).toEqual([
            { state: 'completed', attempts: 1 },
          ])
          expect(yield* storedClaims(healthy.document.id)).toEqual([{ held: false }])
          expect(yield* pendingWork()).toEqual([])
        }),
      CRASH_TIMEOUT_MS,
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
        const owned = nativeLaunch(Fixture.cases.faulted.make({}), EXTRACTION_HEAP_MB)
        yield* delivery(extractWith(owned.launch))
        yield* Deferred.await(owned.ended)
        expect(yield* reportRemoved(owned)).toBe(true)
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
        const owned = nativeLaunch(Fixture.cases.faulted.make({}), EXTRACTION_HEAP_MB)
        expect(yield* delivery(extractWith(owned.launch)).pipe(Effect.flip)).toEqual(
          new ExtractionFaulted(),
        )
        yield* Deferred.await(owned.ended)
        expect(yield* reportRemoved(owned)).toBe(true)
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
