import { sql } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { InvalidRequest } from '@vivid/contracts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { fixture } from './fixtures.ts'
import { hierarchyWrite } from './hierarchy.ts'
import { LibraryStore, libraryStoreLayer } from './store.ts'

const testLayer = libraryStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))
const decodeLocks = Schema.decodeUnknownEffect(
  Schema.Struct({ rows: Schema.Array(Schema.Struct({ held: Schema.Boolean })) }),
)

describe.skipIf(!testDatabaseConfigured)('Library hierarchy transaction', () => {
  layer(testLayer)((it) => {
    it.effect(
      'guarded database queries own the hierarchy lock and store writes roll back with it',
      () =>
        Effect.gen(function* () {
          const people = yield* fixture()
          const database = yield* Database
          const store = yield* LibraryStore
          const failure = yield* hierarchyWrite(
            database,
            Effect.gen(function* () {
              // A pooled connection cannot own the lock held by another reserved transaction connection.
              const receipt = yield* database.run(
                database.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
              AND relation = 'vivid_library_folders'::regclass
              AND mode = 'ShareRowExclusiveLock' AND granted
          ) AS held
        `),
              )
              const locks = yield* decodeLocks(receipt)
              expect((yield* returned(locks.rows, 'Hierarchy lock receipt')).held).toBe(true)
              yield* store.createFolder(people.owner.actor, {
                name: 'Rolled back',
                shelf: 'Mine',
                parentId: null,
              })
              return yield* Effect.fail(
                new InvalidRequest({ message: 'Deliberately abort guarded write' }),
              )
            }),
          ).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(InvalidRequest)
          expect(
            (yield* store.listFolders(people.owner.actor)).map((folder) => folder.name),
          ).not.toContain('Rolled back')
        }),
    )
  })
})
