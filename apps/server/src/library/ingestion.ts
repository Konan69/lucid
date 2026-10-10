import { and, eq } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { LibraryItemId } from '@vivid/contracts'
import { decodeStored } from '../database/client.ts'
import { announce } from '../live/changes.ts'
import { shelfTopics } from './access.ts'
import type { LibraryDatabase } from './store.ts'
import { libraryChunks, libraryDocuments } from './tables.ts'

export const INGESTION_ATTEMPTS = 8
/** One persisted queue identity also scopes the tests' read-only SDK observations. */
export const INGESTION_QUEUE_NAME = 'library-ingestion'

/**
 * This finite int32-safe SDK ceiling keeps product exhaustion writes owed after budget eight.
 * G1: reaching it can leave processing bytes with terminal work. G2: damaged/incompatible payloads
 * are silently dead-lettered before the handler. G3: a persistently faulty exhaustion write stays
 * pending until recovery or G1. rc.116 PersistedQueue.ts:390-392,1729-1755,1811 supplies these gaps.
 */
export const ATTEMPT_CEILING = 2147483647
export const ingestionBackoff = Schedule.min([
  Schedule.exponential('1 second'),
  Schedule.spaced('5 minutes'),
])

/** Persisted payload changes must preserve decoding of every earlier obligation (PQ:1729-1735). */
export const LibraryIngestion = Schema.Struct({ itemId: LibraryItemId })
export const IngestionOutcome = Schema.TaggedUnion({
  Indexed: {
    extractedText: Schema.String,
    chunks: Schema.Array(Schema.Struct({ page: Schema.NullOr(Schema.Int), text: Schema.String })),
  },
  Failed: { message: Schema.String },
})

const documentFields = createSelectSchema(libraryDocuments).fields
const OwedItem = Schema.Struct({
  name: documentFields.name,
  mimeType: documentFields.mimeType,
  // Native Effect PgTypes.ts:1184-1188 decodes bytea as Uint8Array. Drizzle's generated Buffer
  // schema describes a different driver's output and would reject every owed ingestion item.
  bytes: Schema.Uint8Array,
})
export type OwedLibraryItem = typeof OwedItem.Type
const decodeOwed = decodeStored(OwedItem, 'Library ingestion item')
const decodeStranded = decodeStored(Schema.Struct({ id: LibraryItemId }), 'stranded Library item')
type Transaction = Parameters<Parameters<LibraryDatabase['transaction']>[0]>[0]

/** Replace one processing item's index on its settlement transaction, preserving page order. */
const writeIndexed = Effect.fn('LibraryIngestion.writeIndexed')(function* (
  transaction: Transaction,
  itemId: LibraryItemId,
  updatedAt: number,
  outcome: typeof IngestionOutcome.cases.Indexed.Type,
) {
  yield* transaction.delete(libraryChunks).where(eq(libraryChunks.documentId, itemId))
  yield* Effect.forEach(
    outcome.chunks,
    (chunk, ordinal) =>
      transaction.insert(libraryChunks).values({
        id: crypto.randomUUID(),
        documentId: itemId,
        ordinal,
        page: chunk.page,
        text: chunk.text,
      }),
    { discard: true, concurrency: 1 },
  )
  yield* transaction
    .update(libraryDocuments)
    .set({ status: 'ready', extractedText: outcome.extractedText, error: null, updatedAt })
    .where(eq(libraryDocuments.id, itemId))
})

/** Offer id is the item identity; native metadata owns attempts, rc.116 PQ:96-108,1347-1353. */
export const libraryIngestion = (retrySchedule: Schedule.Schedule<unknown, number>) =>
  PersistedQueue.make({
    name: INGESTION_QUEUE_NAME,
    schema: LibraryIngestion,
    maxAttempts: ATTEMPT_CEILING,
    retrySchedule,
  })

/**
 * Accepted product ownership replaces session authority. Reads and settlement concern only owed
 * processing rows; the row lock serializes concurrent settlers and deletion before announcement.
 * rc.116 SqlClient.ts:162-171 joins transaction context; live/changes.ts announce uses that writer.
 */
export const ingestionOperations = (database: LibraryDatabase) => {
  /** Missing and settled rows both end an obligation; only processing bytes cross extraction. */
  const owed = Effect.fn('LibraryIngestion.owed')(function* (itemId: LibraryItemId) {
    const rows = yield* database.run(
      database
        .select({
          name: libraryDocuments.name,
          mimeType: libraryDocuments.mimeType,
          bytes: libraryDocuments.bytes,
        })
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.id, itemId), eq(libraryDocuments.status, 'processing'))),
    )
    const row = rows[0]
    return row === undefined ? Option.none<OwedLibraryItem>() : Option.some(yield* decodeOwed(row))
  })

  /** Chunks, status and stored-owner notice share one commit, and settled rows stay unchanged. */
  const settle = Effect.fn('LibraryIngestion.settle')(
    (itemId: LibraryItemId, outcome: typeof IngestionOutcome.Type) =>
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const rows = yield* transaction
            .select({
              personId: libraryDocuments.personId,
              companyId: libraryDocuments.companyId,
            })
            .from(libraryDocuments)
            .where(and(eq(libraryDocuments.id, itemId), eq(libraryDocuments.status, 'processing')))
            .for('update')
          const row = rows[0]
          if (row === undefined) return
          const updatedAt = yield* Clock.currentTimeMillis
          yield* IngestionOutcome.match(outcome, {
            Indexed: (indexed) => writeIndexed(transaction, itemId, updatedAt, indexed),
            Failed: ({ message }) =>
              transaction
                .update(libraryDocuments)
                .set({
                  status: 'failed',
                  error: message.slice(0, 1000),
                  updatedAt,
                })
                .where(eq(libraryDocuments.id, itemId))
                .pipe(Effect.asVoid),
          })
          yield* announce(transaction, shelfTopics(row))
        }),
      ),
  )

  /** Startup adoption finds processing rows written before the queue obligation was introduced. */
  const stranded = Effect.fn('LibraryIngestion.stranded')(function* () {
    const rows = yield* database.run(
      database
        .select({ id: libraryDocuments.id })
        .from(libraryDocuments)
        .where(eq(libraryDocuments.status, 'processing')),
    )
    return yield* Effect.forEach(rows, decodeStranded)
  })
  return { owed, settle, stranded }
}
