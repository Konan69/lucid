import { workLayer } from '../database/work.ts'
import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { PersonId, type LibraryShelf } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic, everyPart } from '../live/changes.ts'
import { LibraryFolderCycle } from './access.ts'
import { asPerson, fixture } from './fixtures.ts'
import { digestBytes } from './ingest.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

/** The real store and ready PostgreSQL listener share the disposable database adapter. */
const testLayer = Layer.mergeAll(libraryStoreLayer, changesLayer).pipe(
  Layer.provideMerge(workLayer.pipe(Layer.provideMerge(testDatabaseLayer))),
)
const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * A committed marker bounds the real channel without waiting for an absent notification.
 * Adapted from live/changes.test.ts announcedBefore; PgClient.ts:228-231 confirms LISTEN first.
 */
const announcedBefore = Effect.fn('LibraryTest.announcedBefore')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
) {
  const database = yield* Database
  const marker = [Topic.person(PersonId.make(crypto.randomUUID()))]
  yield* database.transaction((transaction) => announce(transaction, marker))
  return yield* Stream.fromQueue(notifications).pipe(
    Stream.takeWhile((notification) => notification.payload !== JSON.stringify(marker)),
    Stream.mapEffect((notification) => decodeTopics(notification.payload)),
    Stream.runCollect,
  )
})

/** Upload setup uses the public store without running ingestion, which belongs to D2. */
const upload = Effect.fn('LibraryTest.announcementItem')(function* (
  actor: Parameters<LibraryStore['Service']['createItem']>[0],
  shelf: LibraryShelf,
) {
  const bytes = new TextEncoder().encode(crypto.randomUUID())
  return yield* (yield* LibraryStore).createItem(actor, {
    name: 'Announcement.txt',
    mimeType: 'text/plain',
    size: bytes.byteLength,
    folderId: null,
    shelf,
    bytes,
    sha256: digestBytes(bytes),
  })
})

describe.skipIf(!testDatabaseConfigured)('Library transactional announcements', () => {
  layer(testLayer)((it) => {
    /** A1: the public folder write reaches the real Company subscriber after commit. */
    it.effect('announces a Company folder to its Company subscriber', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const subscription = yield* (yield* Changes).subscribe(
          [Topic.company(people.company.id)],
          everyPart,
        )
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* (yield* LibraryStore).createFolder(people.owner.actor, {
          name: 'Company folder',
          shelf: 'Company',
          parentId: null,
        })
        // Assert the ordered channel first, so a missing notice fails rather than hanging runHead.
        expect(yield* announcedBefore(notifications)).toEqual([[Topic.company(people.company.id)]])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
      }).pipe(Effect.scoped),
    )

    /** A2: workspace context cannot expand the audience of a private Mine metadata write. */
    it.effect('announces a Mine patch only to the stored owner Person', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const item = yield* upload(people.owner.actor, 'Mine')
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const patched = yield* (yield* LibraryStore).patchItem(
          people.owner.actor,
          item.document.id,
          { name: 'Renamed.txt' },
        )
        expect(Option.isSome(patched)).toBe(true)
        expect(yield* announcedBefore(notifications)).toEqual([
          [Topic.person(people.owner.actor.person.id)],
        ])
      }).pipe(Effect.scoped),
    )

    /** A3: cycle refusal rolls back its transaction and has no notice before a later commit. */
    it.effect('announces nothing when a folder move would form a cycle', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const store = yield* LibraryStore
        const parent = yield* store.createFolder(people.owner.actor, {
          name: 'Parent',
          shelf: 'Company',
          parentId: null,
        })
        const child = yield* store.createFolder(people.owner.actor, {
          name: 'Child',
          shelf: 'Company',
          parentId: parent.id,
        })
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* store
          .patchFolder(people.owner.actor, parent.id, { parentId: child.id })
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(LibraryFolderCycle)
        expect(yield* announcedBefore(notifications)).toEqual([])
        const unchanged = yield* store.getFolder(people.owner.actor, parent.id)
        expect(Option.isSome(unchanged) && unchanged.value.parentId === null).toBe(true)
      }).pipe(Effect.scoped),
    )

    /** A4: an admin deletion uses the removed row's Company, and the RPC adds no second notice. */
    it.effect('announces an admin removal of another Member Company item', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const item = yield* upload(people.owner.actor, 'Company')
        const subscription = yield* (yield* Changes).subscribe(
          [Topic.company(people.company.id)],
          everyPart,
        )
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* asPerson(people.admin).remove(item.document.id)
        expect(
          Option.isNone(yield* (yield* LibraryStore).getItem(people.owner.actor, item.document.id)),
        ).toBe(true)
        expect(yield* announcedBefore(notifications)).toEqual([[Topic.company(people.company.id)]])
        expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
      }).pipe(Effect.scoped),
    )
  })
})
