import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { describe, expect, layer } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Option, Schedule, Stream } from 'effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { DatabaseFailure, LibraryItemId } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { workLayer } from '../database/work.ts'
import { Changes, changesLayer, Topic } from '../live/changes.ts'
import { extractPdf } from './extraction.ts'
import { fixture, pendingWork, storedWork } from './fixtures.ts'
import { digestBytes } from './ingest.ts'
import { ingestionOperations } from './ingestion.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'
import { libraryDocuments } from './tables.ts'
import { libraryIngestionLayer } from './worker.ts'

/** tests/setup.ts gives this file a private clone; queue, store and notices share its SQL client. */
const processLayer = Layer.mergeAll(libraryStoreLayer, changesLayer).pipe(
  Layer.provideMerge(workLayer),
  Layer.provideMerge(testDatabaseLayer),
)

/** Model a pre-queue upload through product rows only; worker.ts:45-50 must adopt its missing work. */
const processingItem = Effect.fn('LibraryAdoption.processingItem')(function* (actor: Actor) {
  const database = yield* Database
  const id = LibraryItemId.make(crypto.randomUUID())
  const bytes = new TextEncoder().encode('adopted amethyst')
  yield* database.run(
    database.insert(libraryDocuments).values({
      id,
      personId: actor.person.id,
      companyId: null,
      name: 'Adopted.txt',
      mimeType: 'text/plain',
      size: bytes.byteLength,
      sha256: digestBytes(bytes),
      status: 'processing',
      bytes: Buffer.from(bytes),
      extractedText: '',
      error: null,
      createdAt: 0,
      updatedAt: 0,
      folderId: null,
    }),
  )
  return id
})

/**
 * Hide the actual product relation for adoption's first read, retaining its rows and foreign keys.
 * Register restoration before rename. rc.116 Effect.ts:13054-13058 requires an infallible release;
 * orDie exposes a failed restore. Native PgConnection.ts:1413-1428 and internal/sqlError.ts:49-54
 * classify missing-relation SQLSTATE 42P01, which database/client.ts maps to DatabaseFailure.
 */
const documentsAbsent = Effect.fn('LibraryAdoption.documentsAbsent')(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.acquireRelease(Effect.void, () =>
    sql`ALTER TABLE IF EXISTS vivid_test_parked_documents RENAME TO vivid_library_documents`.pipe(
      Effect.orDie,
    ),
  )
  yield* sql`ALTER TABLE vivid_library_documents RENAME TO vivid_test_parked_documents`
})

describe.skipIf(!testDatabaseConfigured)('Native Library startup adoption', () => {
  layer(Layer.merge(processLayer, NodeFileSystem.layer))((it) => {
    /**
     * Q11: read-only stages distinguish adoption from settlement. rc.116 PersistedQueue.ts:1512
     * writes attempts at claim; acknowledgement at :1739-1740 races the read, so state is unasserted.
     * Empty pending work and stranded input ensure the first claim needs no worker clock advance.
     */
    it.effect('Q11 adopts pre-existing processing rows on worker startup', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const database = yield* Database
        const id = yield* processingItem(owner.actor)
        expect(yield* ingestionOperations(database).stranded(), 'Q11 adoption input').toEqual([
          { id },
        ])
        expect(yield* storedWork(id), 'Q11 before Layer build').toEqual([])
        const subscription = yield* (yield* Changes).subscribe([
          Topic.person(owner.actor.person.id),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(libraryIngestionLayer(Schedule.forever, extractPdf))
            const adopted = yield* storedWork(id)
            expect(adopted, 'Q11 Layer build returned and adopted').toHaveLength(1)
            for (const row of adopted) expect(row.attempts).toBeLessThanOrEqual(1)
            expect(
              Option.isSome(yield* Stream.runHead(subscription)),
              'Q11 settlement receipt',
            ).toBe(true)
            expect(yield* (yield* LibraryStore).getItem(owner.actor, id)).toMatchObject({
              value: { status: 'ready' },
            })
            expect((yield* storedWork(id)).map((row) => row.attempts)).toEqual([1])
          }),
        )
      }),
    )

    /**
     * Q12: worker.ts:45 reads before offering or forking. A real missing relation must stop the
     * Layer with one DatabaseFailure; rc.116 Cause.ts:170,1060 separates it from pool interruption.
     * After scoped restore, unchanged product data and absent work prove startup stopped there.
     */
    it.effect('Q12 fails startup when adoption cannot read its database', () =>
      Effect.gen(function* () {
        expect(yield* pendingWork()).toEqual([])
        const { owner } = yield* fixture()
        const database = yield* Database
        const store = yield* LibraryStore
        const id = yield* processingItem(owner.actor)
        const original = yield* store.getItem(owner.actor, id)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* documentsAbsent()
            const exit = yield* Effect.exit(
              Layer.build(libraryIngestionLayer(Schedule.forever, extractPdf)),
            )
            expect(Exit.isFailure(exit), 'Q12 startup failure').toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.hasInterrupts(exit.cause), 'Q12 no interruption').toBe(false)
              expect(Cause.hasDies(exit.cause), 'Q12 no defect').toBe(false)
              const failures = exit.cause.reasons.filter(Cause.isFailReason)
              expect(failures, 'Q12 exactly one typed failure').toHaveLength(1)
              for (const failure of failures) expect(failure.error).toBeInstanceOf(DatabaseFailure)
            }
          }),
        )
        expect(yield* ingestionOperations(database).stranded(), 'Q12 restored relation').toEqual([
          { id },
        ])
        expect(yield* storedWork(id), 'Q12 no offer').toEqual([])
        const restored = yield* store.getItem(owner.actor, id)
        expect(restored).toEqual(original)
        expect(restored).toMatchObject({ value: { status: 'processing' } })
      }),
    )
  })
})
