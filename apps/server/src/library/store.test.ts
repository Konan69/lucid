import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import {
  Forbidden,
  Conflict,
  InvalidRequest,
  LibraryUploadMetadata,
  NotFound,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { LibraryFolderCycle, LibraryMutationDenied } from './access.ts'
import { asPerson, fixture } from './fixtures.ts'
import { libraryHandlers } from './handlers.ts'
import { digestBytes, ingestLibraryItem } from './ingest.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

const testLayer = libraryStoreLayer.pipe(
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(silentChangesLayer),
)

/** Exercises production insertion and extraction so searches use the real generated tsvector. */
const upload = Effect.fn('LibraryTest.upload')(function* (
  actor: Parameters<LibraryStore['Service']['createItem']>[0],
  shelf: typeof LibraryUploadMetadata.Type.shelf,
  text: string,
) {
  const bytes = new TextEncoder().encode(text)
  const store = yield* LibraryStore
  const result = yield* store.createItem(actor, {
    name: `${digestBytes(bytes)}.txt`,
    mimeType: 'text/plain',
    size: bytes.length,
    folderId: null,
    shelf,
    bytes,
    sha256: digestBytes(bytes),
  })
  if (result.duplicate !== true) yield* ingestLibraryItem(actor, result.document.id)
  return result
})

describe.skipIf(!testDatabaseConfigured)('Library shelves', () => {
  layer(testLayer)((it) => {
    it.effect(
      'Mine follows its Person and is invisible by list, id, bytes, search and deletion to another Person',
      () =>
        Effect.gen(function* () {
          const people = yield* fixture()
          const store = yield* LibraryStore
          const item = yield* upload(people.owner.actor, 'Mine', 'confidential quartz evidence')
          const owner = asPerson(people.owner)
          const reader = asPerson(people.reader)
          expect(
            (yield* owner.list({ shelf: 'Mine' })).documents.map((document) => document.id),
          ).toContain(item.document.id)
          const personal = { ...people.owner.actor, workspace: Workspace.cases.Personal.make({}) }
          expect(
            (yield* store.list(personal, { shelf: 'Mine' })).documents.map(
              (document) => document.id,
            ),
          ).toContain(item.document.id)
          expect((yield* reader.list({ shelf: 'Mine' })).documents).toHaveLength(0)
          expect(yield* reader.get(item.document.id).pipe(Effect.flip)).toBeInstanceOf(NotFound)
          expect(
            Option.isNone(yield* store.getStoredItem(people.reader.actor, item.document.id)),
          ).toBe(true)
          expect(
            Option.isNone(
              yield* store.getStoredItemByName(people.reader.actor, item.document.name),
            ),
          ).toBe(true)
          expect((yield* reader.search('quartz')).results).toHaveLength(0)
          expect(yield* reader.remove(item.document.id).pipe(Effect.flip)).toBeInstanceOf(NotFound)
          expect(
            yield* asPerson(people.admin).get(item.document.id).pipe(Effect.flip),
          ).toBeInstanceOf(NotFound)
          expect(
            yield* owner.patch({ id: item.document.id, patch: { name: 'Renamed.txt' } }),
          ).toMatchObject({ document: { name: 'Renamed.txt' } })
        }),
    )
    it.effect('Company Members read and add; only contributors and admins mutate', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const store = yield* LibraryStore
        const item = yield* upload(people.owner.actor, 'Company', 'shared sapphire evidence')
        const reader = asPerson(people.reader)
        expect(
          (yield* reader.list({ shelf: 'Company' })).documents.map((document) => document.id),
        ).toContain(item.document.id)
        expect((yield* reader.get(item.document.id)).document.shelf).toBe('Company')
        expect(
          (yield* reader.search('sapphire')).results.map((result) => result.documentId),
        ).toContain(item.document.id)
        expect(
          Option.isSome(yield* store.getStoredItem(people.reader.actor, item.document.id)),
        ).toBe(true)
        expect(
          yield* reader
            .patch({ id: item.document.id, patch: { name: 'Other.txt' } })
            .pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        expect(yield* reader.remove(item.document.id).pipe(Effect.flip)).toBeInstanceOf(Forbidden)
        const foreignActor = {
          ...people.reader.actor,
          workspace: Workspace.cases.Company.make({ company: people.foreign, role: 'admin' }),
        }
        expect(Option.isNone(yield* store.getItem(foreignActor, item.document.id))).toBe(true)
        const added = yield* upload(
          people.reader.actor,
          'Company',
          'another shared emerald document',
        )
        expect(added.document.shelf).toBe('Company')
        yield* asPerson(people.admin).remove(item.document.id)
        expect(yield* reader.get(item.document.id).pipe(Effect.flip)).toBeInstanceOf(NotFound)
        const personal = { ...people.owner.actor, workspace: Workspace.cases.Personal.make({}) }
        expect(
          yield* store.list(personal, { shelf: 'Company' }).pipe(
            Effect.mapError((failure) => failure._tag),
            Effect.flip,
          ),
        ).toBe('LibraryShelfUnavailable')
      }),
    )
    it.effect('the same bytes are unique per shelf, including simultaneous uploads', () =>
      Effect.gen(function* () {
        const people = yield* fixture()
        const mine = yield* upload(people.owner.actor, 'Mine', 'identical library content')
        const company = yield* upload(people.owner.actor, 'Company', 'identical library content')
        expect(mine.document.id).not.toBe(company.document.id)
        const duplicates = yield* Effect.all(
          [
            upload(people.owner.actor, 'Mine', 'identical library content'),
            upload(people.reader.actor, 'Company', 'identical library content'),
          ],
          { concurrency: 2 },
        )
        expect(duplicates.map((result) => result.duplicate)).toEqual([true, true])
        const concurrent = yield* Effect.all(
          [
            upload(people.owner.actor, 'Mine', 'simultaneous upload'),
            upload(people.owner.actor, 'Mine', 'simultaneous upload'),
          ],
          { concurrency: 2 },
        )
        expect(new Set(concurrent.map((result) => result.document.id)).size).toBe(1)
        expect(concurrent.filter((result) => result.duplicate === true)).toHaveLength(1)
      }),
    )
    it.effect(
      'Vivid ranks Company chunks only in a shared Thread and both shelves in a private Thread',
      () =>
        Effect.gen(function* () {
          const people = yield* fixture()
          const database = yield* Database
          const mine = yield* upload(
            people.owner.actor,
            'Mine',
            'topaz topaz topaz private evidence',
          )
          const company = yield* upload(people.reader.actor, 'Company', 'topaz shared evidence')
          const sharedId = ThreadId.make(crypto.randomUUID())
          const privateId = ThreadId.make(crypto.randomUUID())
          yield* database.run(
            database.insert(threads).values([
              {
                id: sharedId,
                title: 'Shared search',
                titleSource: 'Person',
                personId: people.owner.actor.person.id,
                companyId: people.company.id,
                audience: 'company',
                updatedAt: 1,
              },
              {
                id: privateId,
                title: 'Private search',
                titleSource: 'Person',
                personId: people.owner.actor.person.id,
                companyId: people.company.id,
                audience: 'private',
                updatedAt: 1,
              },
            ]),
          )
          const auth = (threadId: ThreadId) =>
            AuthState.Vivid({
              person: people.owner.actor.person,
              workspace: people.owner.actor.workspace,
              threadId,
            })
          const shared = yield* libraryHandlers
            .SearchLibrary({ query: 'topaz', limit: 1 })
            .pipe(Effect.provideService(AuthContext, auth(sharedId)))
          expect(shared.results.map((result) => result.documentId)).toEqual([company.document.id])
          const personal = yield* libraryHandlers
            .SearchLibrary({ query: 'topaz' })
            .pipe(Effect.provideService(AuthContext, auth(privateId)))
          expect(personal.results.map((result) => result.documentId)).toEqual(
            expect.arrayContaining([mine.document.id, company.document.id]),
          )
        }),
    )
    it.effect(
      'folders enforce shelf boundaries, contributor authority, nonempty deletion and cycles',
      () =>
        Effect.gen(function* () {
          const people = yield* fixture()
          const store = yield* LibraryStore
          const mine = yield* store.createFolder(people.owner.actor, {
            name: 'Mine',
            shelf: 'Mine',
            parentId: null,
          })
          const company = yield* store.createFolder(people.owner.actor, {
            name: 'Company',
            shelf: 'Company',
            parentId: null,
          })
          const child = yield* store.createFolder(people.owner.actor, {
            name: 'Child',
            shelf: 'Company',
            parentId: company.id,
          })
          const auth = AuthState.Person({
            person: people.owner.actor.person,
            workspace: people.owner.actor.workspace,
            sessionId: people.owner.sessionId,
          })
          const move = libraryHandlers
            .PatchLibraryFolder({ id: mine.id, patch: { parentId: company.id } })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(yield* move.pipe(Effect.flip)).toBeInstanceOf(InvalidRequest)
          expect(
            yield* store
              .patchFolder(people.owner.actor, company.id, { parentId: child.id })
              .pipe(Effect.flip),
          ).toBeInstanceOf(LibraryFolderCycle)
          expect(
            yield* store.removeFolder(people.owner.actor, company.id).pipe(Effect.flip),
          ).toBeInstanceOf(Conflict)
          expect(
            yield* store
              .patchFolder(people.reader.actor, company.id, { name: 'Renamed' })
              .pipe(Effect.flip),
          ).toBeInstanceOf(LibraryMutationDenied)
          const item = yield* upload(people.owner.actor, 'Mine', 'folder move evidence')
          expect(
            yield* asPerson(people.owner)
              .patch({ id: item.document.id, patch: { folderId: company.id } })
              .pipe(Effect.flip),
          ).toBeInstanceOf(InvalidRequest)
          expect(
            (yield* store.listFolders(people.reader.actor)).map((folder) => folder.id),
          ).not.toContain(mine.id)
          yield* store.removeFolder(people.admin.actor, child.id)
          yield* store.removeFolder(people.admin.actor, company.id)
        }),
    )
  })
})
