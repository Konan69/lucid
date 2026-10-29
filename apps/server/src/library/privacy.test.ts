import { workLayer } from '../database/work.ts'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { NotFound, ThreadId, type LibraryShelf } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { fixture } from './fixtures.ts'
import { libraryHandlers } from './handlers.ts'
import { digestBytes } from './ingest.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

const testLayer = libraryStoreLayer.pipe(
  Layer.provideMerge(workLayer.pipe(Layer.provideMerge(testDatabaseLayer))),
  Layer.provideMerge(silentChangesLayer),
)

/** Real rows cover private, selected-people and whole-Company Threads under the same Person. */
const setup = Effect.fn('LibraryPrivacy.setup')(function* () {
  const people = yield* fixture()
  const store = yield* LibraryStore
  const database = yield* Database
  const actor = people.owner.actor
  /** Metadata reads must protect processing uploads as well as indexed files. */
  const item = Effect.fn('LibraryPrivacy.item')(function* (shelf: LibraryShelf) {
    const bytes = new TextEncoder().encode(`${shelf} private boundary`)
    const result = yield* store.createItem(actor, {
      name: `${shelf}.txt`,
      mimeType: 'text/plain',
      size: bytes.length,
      bytes,
      sha256: digestBytes(bytes),
      folderId: null,
      shelf,
    })
    return result.document
  })
  const mine = yield* item('Mine')
  const company = yield* item('Company')
  const mineFolder = yield* store.createFolder(actor, {
    name: 'Mine folder',
    shelf: 'Mine',
    parentId: null,
  })
  const companyFolder = yield* store.createFolder(actor, {
    name: 'Company folder',
    shelf: 'Company',
    parentId: null,
  })
  const privateId = ThreadId.make(crypto.randomUUID())
  const peopleId = ThreadId.make(crypto.randomUUID())
  const companyId = ThreadId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(threads).values([
      {
        id: privateId,
        title: 'Private privacy test',
        titleSource: 'Person',
        audience: 'private',
        personId: actor.person.id,
        companyId: people.company.id,
        updatedAt: 1,
      },
      {
        id: peopleId,
        title: 'People privacy test',
        titleSource: 'Person',
        audience: 'people',
        personId: actor.person.id,
        companyId: people.company.id,
        updatedAt: 1,
      },
      {
        id: companyId,
        title: 'Company privacy test',
        titleSource: 'Person',
        audience: 'company',
        personId: actor.person.id,
        companyId: people.company.id,
        updatedAt: 1,
      },
    ]),
  )
  const auth = (threadId: ThreadId) =>
    AuthState.Vivid({ person: actor.person, workspace: actor.workspace, threadId })
  const vivid = (threadId: ThreadId): Actor => ({
    ...actor,
    by: 'vivid',
    threadId: Option.some(threadId),
    helper: Option.none(),
  })
  return {
    mine,
    company,
    mineFolder,
    companyFolder,
    actor,
    privateAuth: auth(privateId),
    sharedAuths: [auth(peopleId), auth(companyId)],
    privateActor: vivid(privateId),
    sharedActors: [vivid(peopleId), vivid(companyId)],
  }
})

describe.skipIf(!testDatabaseConfigured)('Library Thread privacy', () => {
  layer(testLayer)((it) => {
    it.effect('ListLibrary omits Mine documents and folders in both kinds of shared Thread', () =>
      Effect.gen(function* () {
        const data = yield* setup()
        yield* Effect.forEach(
          data.sharedAuths,
          (auth) =>
            Effect.gen(function* () {
              const mine = yield* libraryHandlers
                .ListLibrary({ shelf: 'Mine' })
                .pipe(Effect.provideService(AuthContext, auth))
              expect(mine.documents).toEqual([])
              expect(mine.folders).toEqual([])
              const company = yield* libraryHandlers
                .ListLibrary({ shelf: 'Company' })
                .pipe(Effect.provideService(AuthContext, auth))
              expect(company.documents.map((item) => item.id)).toEqual([data.company.id])
              expect(company.folders.map((folder) => folder.id)).toEqual([data.companyFolder.id])
            }),
          { discard: true },
        )
        const privateList = yield* libraryHandlers
          .ListLibrary({ shelf: 'Mine' })
          .pipe(Effect.provideService(AuthContext, data.privateAuth))
        expect(privateList.documents.map((item) => item.id)).toEqual([data.mine.id])
        expect(privateList.folders.map((folder) => folder.id)).toEqual([data.mineFolder.id])
      }),
    )
    it.effect(
      'GetLibraryItem returns NotFound for Mine in shared Threads but returns Company items',
      () =>
        Effect.gen(function* () {
          const data = yield* setup()
          yield* Effect.forEach(
            data.sharedAuths,
            (auth) =>
              Effect.gen(function* () {
                const hidden = yield* libraryHandlers
                  .GetLibraryItem({ id: data.mine.id })
                  .pipe(Effect.provideService(AuthContext, auth), Effect.flip)
                expect(hidden).toBeInstanceOf(NotFound)
                const visible = yield* libraryHandlers
                  .GetLibraryItem({ id: data.company.id })
                  .pipe(Effect.provideService(AuthContext, auth))
                expect(visible.document.id).toBe(data.company.id)
              }),
            { discard: true },
          )
          expect(
            (yield* libraryHandlers
              .GetLibraryItem({ id: data.mine.id })
              .pipe(Effect.provideService(AuthContext, data.privateAuth))).document.id,
          ).toBe(data.mine.id)
        }),
    )
    it.effect(
      'ListLibraryFolders and direct LibraryStore.list cannot expose Mine to search in shared Threads',
      () =>
        Effect.gen(function* () {
          const data = yield* setup()
          const store = yield* LibraryStore
          yield* Effect.forEach(
            data.sharedActors,
            (actor) =>
              Effect.gen(function* () {
                const mine = yield* store.list(actor, { shelf: 'Mine' })
                expect(mine.documents).toEqual([])
                expect(mine.folders).toEqual([])
                expect(Option.isNone(yield* store.getStoredItem(actor, data.mine.id))).toBe(true)
                expect(Option.isNone(yield* store.getStoredItemByName(actor, data.mine.name))).toBe(
                  true,
                )
              }),
            { discard: true },
          )
          yield* Effect.forEach(
            data.sharedAuths,
            (auth) =>
              Effect.gen(function* () {
                const result = yield* libraryHandlers
                  .ListLibraryFolders()
                  .pipe(Effect.provideService(AuthContext, auth))
                expect(result.folders.map((folder) => folder.id)).toEqual([data.companyFolder.id])
                expect(
                  yield* libraryHandlers
                    .ListLibrary({ shelf: 'Mine', folderId: data.mineFolder.id })
                    .pipe(Effect.provideService(AuthContext, auth), Effect.flip),
                ).toBeInstanceOf(NotFound)
              }),
            { discard: true },
          )
          expect(
            (yield* store.list(data.actor, { shelf: 'Mine' })).documents.map((item) => item.id),
          ).toEqual([data.mine.id])
          const privateFolders = yield* libraryHandlers
            .ListLibraryFolders()
            .pipe(Effect.provideService(AuthContext, data.privateAuth))
          expect(privateFolders.folders.map((folder) => folder.id)).toEqual(
            expect.arrayContaining([data.mineFolder.id, data.companyFolder.id]),
          )
        }),
    )
  })
})
