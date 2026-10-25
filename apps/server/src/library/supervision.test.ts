import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeFS from 'node:fs'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Logger, Option, Queue, Ref, Schedule, Stream } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { WORK_TABLE, workLayer } from '../database/work.ts'
import { Changes, changesLayer, everyPart, Topic } from '../live/changes.ts'
import { type extractPdf } from './extraction.ts'
import { fixture, storedWork } from './fixtures.ts'
import { digestBytes } from './ingest.ts'
import { INGESTION_QUEUE_NAME } from './ingestion.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'
import { libraryIngestionLayer } from './worker.ts'

const processLayer = Layer.merge(libraryStoreLayer, changesLayer).pipe(
  Layer.provideMerge(workLayer),
  Layer.provideMerge(testDatabaseLayer),
)
const bytes = new Uint8Array(
  NodeFS.readFileSync(new URL('./fixtures/readable.pdf', import.meta.url)),
)

/** Real persisted work and product settlement prove the scoped taker, rather than manual
 * redelivery, recovers from a defect. The failure log acknowledges when its restart delay begins. */
describe.skipIf(!testDatabaseConfigured)('Library taker supervision', () => {
  layer(Layer.merge(processLayer, NodeFileSystem.layer))((it) => {
    it.effect(
      'restarts after a defect and settles the owed item without rebuilding its Layer',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const sql = yield* SqlClient.SqlClient
          yield* Effect.addFinalizer(() =>
            sql`
          DELETE FROM ${sql(WORK_TABLE)} WHERE queue_name = ${INGESTION_QUEUE_NAME}
          AND id IN (SELECT id FROM vivid_library_documents WHERE person_id = ${owner.actor.person.id})
        `.pipe(Effect.orDie),
          )
          const store = yield* LibraryStore
          const item = yield* store.createItem(owner.actor, {
            name: 'Recovery.pdf',
            mimeType: 'application/pdf',
            size: bytes.byteLength,
            folderId: null,
            shelf: 'Mine',
            bytes,
            sha256: digestBytes(bytes),
          })
          const calls = yield* Ref.make(0)
          const failures = yield* Queue.unbounded<string>()
          const capture = Logger.make(({ message, logLevel }) => {
            const line = JSON.stringify(message)
            if (line.includes('Library ingestion') && !line.includes('delivery'))
              Queue.offerUnsafe(failures, logLevel)
          })
          const extract: typeof extractPdf = (input) =>
            Effect.gen(function* () {
              expect(input).toEqual(bytes)
              if ((yield* Ref.getAndUpdate(calls, (count) => count + 1)) === 0)
                return yield* Effect.die('deliberate extractor defect')
              return ['recovered amethyst']
            })
          const subscription = yield* (yield* Changes).subscribe(
            [Topic.person(owner.actor.person.id)],
            everyPart,
          )
          yield* Layer.build(
            libraryIngestionLayer(Schedule.forever, extract).pipe(
              Layer.provide(Logger.layer([capture])),
            ),
          )
          expect(yield* Queue.take(failures)).toBe('Error')
          expect(yield* storedWork(item.document.id)).toEqual([{ state: 'pending', attempts: 1 }])
          yield* TestClock.adjust('500 millis')
          const settled = yield* subscription.pipe(
            Stream.mapEffect(() => store.getItem(owner.actor, item.document.id)),
            Stream.filter(Option.exists((document) => document.status === 'ready')),
            Stream.runHead,
          )
          expect(Option.isSome(settled)).toBe(true)
          expect(yield* Ref.get(calls)).toBe(2)
          expect(yield* store.getItem(owner.actor, item.document.id)).toMatchObject({
            value: { status: 'ready' },
          })
        }).pipe(Effect.scoped),
    )
  })
})
