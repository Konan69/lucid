import { layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { Clock, Config, Deferred, Effect, Fiber, Layer, Option, Schedule, Schema } from 'effect'
import * as PersistedQueue from 'effect/unstable/persistence/PersistedQueue'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { LibraryItemId, NotFound } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { postgresCodecs } from '../database/codecs.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { fixture } from './fixtures.ts'
import { digestBytes, ingestLibraryItem } from './ingest.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

/** The SDK encodes and decodes the branded item identifier at its persistence boundary. */
const LibraryIngestion = Schema.Struct({ itemId: LibraryItemId })
type IngestionQueue = PersistedQueue.PersistedQueue<typeof LibraryIngestion.Type>

/** Carries the abandoned product identity so rollback can be checked through the real store. */
class IngestionAbandoned extends Schema.TaggedError<IngestionAbandoned>()(
  'IngestionAbandoned',
  { itemId: LibraryItemId },
  { title: 'Abandoned test ingestion' },
) {}

/** Only the SDK-owned lifecycle fields needed for observations enter the test model. */
const StoredElement = Schema.Struct({
  state: Schema.Literals(['pending', 'completed', 'failed']),
  attempts: Schema.Int,
})
const decodeElements = Schema.decodeUnknownEffect(Schema.Array(StoredElement))

/**
 * One process owns one pool shared by Drizzle and the native queue store. SDK rc.116
 * PersistedQueue.ts:1316 migrates its own tables in this disposable per-file database.
 */
const processLayer = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreSql()),
  Layer.provideMerge(libraryStoreLayer),
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(silentChangesLayer),
)

/** Two attempts with zero retry delay isolate persisted lifecycle from database-clock delays. */
const ingestionQueue = (name: string) =>
  PersistedQueue.make({
    name,
    schema: LibraryIngestion,
    maxAttempts: 2,
    retrySchedule: Schedule.forever,
  })

/** The same bytes reach the real duplicate constraint and the production text extractor. */
const createItem = Effect.fn('LibraryDurability.createItem')(function* (
  actor: Actor,
  text: string,
) {
  const bytes = new TextEncoder().encode(text)
  const store = yield* LibraryStore
  return yield* store.createItem(actor, {
    name: `${digestBytes(bytes)}.txt`,
    mimeType: 'text/plain',
    size: bytes.length,
    folderId: null,
    shelf: 'Mine',
    bytes,
    sha256: digestBytes(bytes),
  })
})

/**
 * Product bytes and the obligation must commit together. The SDK INSERT (rc.116
 * PersistedQueue.ts:1350) uses the same SqlClient transaction as Drizzle's nested savepoint.
 */
const uploadOwingIngestion = Effect.fn('LibraryDurability.uploadOwingIngestion')(function* (
  queue: IngestionQueue,
  actor: Actor,
  text: string,
) {
  const database = yield* Database
  return yield* database.transaction(() =>
    Effect.gen(function* () {
      const item = yield* createItem(actor, text)
      const itemId = item.document.id
      yield* queue.offer(LibraryIngestion.make({ itemId }), { id: itemId })
      return itemId
    }),
  )
})

/** Handler success must index the actual item before the SDK acknowledges its obligation. */
const ingest = (queue: IngestionQueue, actor: Actor) =>
  queue.take((job, metadata) => ingestLibraryItem(actor, job.itemId).pipe(Effect.as(metadata)))

/** Read-only ingress observes SDK state without supplying a replacement store or writing its rows. */
const storedElements = Effect.fn('LibraryDurability.storedElements')(function* (
  name: string,
  id: LibraryItemId,
) {
  const sql = yield* SqlClient.SqlClient
  return yield* decodeElements(
    yield* sql`
    SELECT state, attempts FROM effect_queue WHERE queue_name = ${name} AND id = ${id}
  `,
  )
})

/**
 * Layer.fresh isolates the entire subtree from Vitest's parent memo map (rc.116 Layer.ts:3891).
 * Closing the writer before constructing the reader exercises committed SQL, not a shared latch.
 */
const afterRestart = Effect.fn('LibraryDurability.afterRestart')(function* (
  name: string,
  actor: Actor,
  text: string,
) {
  const suiteClient = yield* SqlClient.SqlClient
  const suiteFactory = yield* PersistedQueue.PersistedQueueFactory
  const written = yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.fresh(processLayer))
      return yield* Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient
        const factory = yield* PersistedQueue.PersistedQueueFactory
        expect(client).not.toBe(suiteClient)
        expect(factory).not.toBe(suiteFactory)
        const itemId = yield* uploadOwingIngestion(yield* ingestionQueue(name), actor, text)
        return { itemId, client, factory }
      }).pipe(Effect.provide(context))
    }),
  )
  const delivered = yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.fresh(processLayer))
      return yield* Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient
        const factory = yield* PersistedQueue.PersistedQueueFactory
        expect(client).not.toBe(suiteClient)
        expect(client).not.toBe(written.client)
        expect(factory).not.toBe(suiteFactory)
        expect(factory).not.toBe(written.factory)
        return yield* ingest(yield* ingestionQueue(name), actor)
      }).pipe(Effect.provide(context))
    }),
  )
  return { itemId: written.itemId, delivered }
})

/**
 * A single connection exposes an extra checkout while the transaction owns the pool. This repeats
 * testdb's configuration only because the production database Layer has no pool-size option.
 */
const singleConnectionLayer = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreSql()),
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
    /** Rollback must remove both processing bytes and owed work, never leaving a ghost delivery. */
    it.effect('rolls the product write and offer back together', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const database = yield* Database
        const store = yield* LibraryStore
        const name = `library-ingestion/${crypto.randomUUID()}`
        const queue = yield* ingestionQueue(name)
        const failure = yield* database
          .transaction(() =>
            Effect.gen(function* () {
              const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'abandoned quartz')
              return yield* Effect.fail(new IngestionAbandoned({ itemId }))
            }),
          )
          .pipe(Effect.catchTag('IngestionAbandoned', Effect.succeed))
        expect(failure).toBeInstanceOf(IngestionAbandoned)
        expect(Option.isNone(yield* store.getStoredItem(owner.actor, failure.itemId))).toBe(true)
        expect(yield* storedElements(name, failure.itemId)).toEqual([])
        const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'committed sapphire')
        expect((yield* ingest(queue, owner.actor)).id).toBe(itemId)
      }),
    )

    /** rc.116 PersistedQueue.ts:1737-1739 acknowledges only after the production handler succeeds. */
    it.effect('delivers committed work and indexes the item before acknowledging', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* LibraryStore
        const name = `library-ingestion/${crypto.randomUUID()}`
        const queue = yield* ingestionQueue(name)
        const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'searchable topaz')
        expect(yield* ingest(queue, owner.actor)).toEqual({ id: itemId, attempts: 1 })
        expect(yield* store.getItem(owner.actor, itemId)).toMatchObject({
          value: { status: 'ready' },
        })
        expect(yield* storedElements(name, itemId)).toEqual([{ state: 'completed', attempts: 1 }])
      }),
    )

    /** SDK rc.116 PersistedQueue.ts:1352 keeps a completed custom id for replay deduplication. */
    it.effect('deduplicates a completed item when the same bytes are uploaded again', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const name = `library-ingestion/${crypto.randomUUID()}`
        const queue = yield* ingestionQueue(name)
        const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'duplicate emerald')
        yield* ingest(queue, owner.actor)
        const duplicate = yield* createItem(owner.actor, 'duplicate emerald')
        expect(duplicate.duplicate).toBe(true)
        expect(duplicate.document.id).toBe(itemId)
        yield* queue.offer(LibraryIngestion.make({ itemId: duplicate.document.id }), { id: itemId })
        expect(yield* storedElements(name, itemId)).toEqual([{ state: 'completed', attempts: 1 }])
        const nextId = yield* uploadOwingIngestion(queue, owner.actor, 'distinct ruby')
        expect((yield* ingest(queue, owner.actor)).id).toBe(nextId)
      }),
    )

    /** No taker exists in the writer scope; a newly built store must discover committed SQL work. */
    it.effect('survives closure of the writing store and pool', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* LibraryStore
        const result = yield* afterRestart(
          `library-ingestion/${crypto.randomUUID()}`,
          owner.actor,
          'restart amethyst',
        )
        expect(result.delivered).toEqual({ id: result.itemId, attempts: 1 })
        expect(yield* store.getItem(owner.actor, result.itemId)).toMatchObject({
          value: { status: 'ready' },
        })
      }),
    )

    /** SDK rc.116 PersistedQueue.ts:1447,1744 releases interrupted work without spending an attempt. */
    it.effect('releases interrupted work without consuming its attempt budget', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* LibraryStore
        const queue = yield* ingestionQueue(`library-ingestion/${crypto.randomUUID()}`)
        const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'interrupted opal')
        const started = yield* Deferred.make<number>()
        const worker = yield* queue
          .take((_job, metadata) =>
            Deferred.succeed(started, metadata.attempts).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkScoped)
        expect(yield* Deferred.await(started)).toBe(1)
        yield* Fiber.interrupt(worker)
        expect(yield* ingest(queue, owner.actor)).toEqual({ id: itemId, attempts: 1 })
        expect(yield* store.getItem(owner.actor, itemId)).toMatchObject({
          value: { status: 'ready' },
        })
      }),
    )

    /** A real deleted item fails ingestion; rc.116 PersistedQueue.ts:1742-1750 bounds redelivery. */
    it.effect('retries handler failure then retains terminal failure after two attempts', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* LibraryStore
        const name = `library-ingestion/${crypto.randomUUID()}`
        const queue = yield* ingestionQueue(name)
        const itemId = yield* uploadOwingIngestion(queue, owner.actor, 'removed garnet')
        yield* store.removeItem(owner.actor, itemId)
        expect(yield* ingest(queue, owner.actor).pipe(Effect.flip)).toBeInstanceOf(NotFound)
        expect(yield* storedElements(name, itemId)).toEqual([{ state: 'pending', attempts: 1 }])
        expect(yield* ingest(queue, owner.actor).pipe(Effect.flip)).toBeInstanceOf(NotFound)
        expect(yield* storedElements(name, itemId)).toEqual([{ state: 'failed', attempts: 2 }])
        const nextId = yield* uploadOwingIngestion(queue, owner.actor, 'new aquamarine')
        expect((yield* ingest(queue, owner.actor)).id).toBe(nextId)
      }),
    )

    /** PostgreSQL transaction NOW is equal for both offers; SDK sequence breaks the tie in order. */
    it.effect('delivers offers from one transaction in insertion order', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const database = yield* Database
        const queue = yield* ingestionQueue(`library-ingestion/${crypto.randomUUID()}`)
        const ids = yield* database.transaction(() =>
          Effect.gen(function* () {
            const first = yield* uploadOwingIngestion(queue, owner.actor, 'first citrine')
            const second = yield* uploadOwingIngestion(queue, owner.actor, 'second beryl')
            return [first, second]
          }),
        )
        const delivered = [yield* ingest(queue, owner.actor), yield* ingest(queue, owner.actor)]
        expect(delivered.map((item) => item.id)).toEqual(ids)
      }),
    )

    /** A fresh factory must share the sole pool's transaction; rollback catches a foreign factory. */
    it.effect('offers inside a transaction with a one-connection pool', () =>
      Effect.gen(function* () {
        const suiteClient = yield* SqlClient.SqlClient
        const context = yield* Layer.build(Layer.fresh(singleConnectionLayer))
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(sql).not.toBe(suiteClient)
          const name = `library-ingestion/${crypto.randomUUID()}`
          const queue = yield* ingestionQueue(name)
          const itemId = LibraryItemId.make(crypto.randomUUID())
          yield* sql
            .withTransaction(
              queue
                .offer(LibraryIngestion.make({ itemId }), { id: itemId })
                .pipe(Effect.andThen(Effect.fail(new IngestionAbandoned({ itemId })))),
            )
            .pipe(Effect.catchTag('IngestionAbandoned', Effect.succeed))
          expect(yield* storedElements(name, itemId)).toEqual([])
          expect(
            yield* sql.withTransaction(
              queue.offer(LibraryIngestion.make({ itemId }), { id: itemId }),
            ),
          ).toBe(itemId)
          expect(yield* queue.take((job) => Effect.succeed(job.itemId))).toBe(itemId)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )
  })
})
