import { eq } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { credentials } from './tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'

const storeLayer = connectionStoreLayer.pipe(
  Layer.provide(testDatabaseLayer),
  Layer.provide(testConfigLayer),
)
const testLayer = Layer.merge(storeLayer, testDatabaseLayer)

describe.skipIf(!testDatabaseConfigured)('ConnectionStore', () => {
  layer(testLayer)((it) => {
    it.effect('lists and removes a persisted credential without exposing its values', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const store = yield* ConnectionStore
        const id = crypto.randomUUID()
        yield* Effect.addFinalizer(() =>
          database
            .run(database.delete(credentials).where(eq(credentials.id, id)))
            .pipe(Effect.ignore),
        )
        yield* database.run(
          database.insert(credentials).values({
            id,
            connectorId: 'gmail',
            accessToken: 'server-only-access-token',
            refreshToken: 'server-only-refresh-token',
            expiresAt: Date.now() + 60_000 * 60,
            scope: 'gmail.readonly',
            createdAt: Date.now(),
          }),
        )

        const connected = yield* store.list()
        expect(connected.find((item) => item.id === 'gmail')).toMatchObject({ status: 'connected' })
        expect(yield* store.remove('gmail')).toBe(1)
        const disconnected = yield* store.list()
        expect(disconnected.find((item) => item.id === 'gmail')).toMatchObject({
          status: 'disconnected',
        })
      }),
    )
  })
})
