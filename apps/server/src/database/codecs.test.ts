import { describe, expect, layer } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { testDatabaseConfigured, testDatabaseLayer } from './testdb.ts'

const decodeRange = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ relation: Schema.Int, highest: Schema.Int })),
)
const decodeRelation = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ relation: Schema.Int })),
)

describe.skipIf(!testDatabaseConfigured)('PostgreSQL catalogue codecs', () => {
  layer(testDatabaseLayer)((it) => {
    /**
     * Regclass uses unsigned OID bytes. 255 is always invalid UTF-8; the upper bound distinguishes
     * the SDK oid codec from signed int4 (rc.116 PgTypes.ts:1227-1245,1644).
     */
    it.effect('reads regclass identifiers across the unsigned OID range', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`
          SELECT 255::oid::regclass AS relation, 4294967295::oid::regclass AS highest
        `
        expect(yield* decodeRange(rows)).toEqual([{ relation: 255, highest: 4294967295 }])
      }),
    )

    /**
     * Matches the parameterized existence check in rc.116 Migrator.ts:137. pg_class's fixed
     * catalogue OID also has invalid UTF-8 bytes, independent of per-test relation allocation.
     */
    it.effect('reads an existing relation using the native migrator statement shape', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`SELECT ${'pg_class'}::regclass AS relation`
        expect(yield* decodeRelation(rows)).toEqual([{ relation: 1259 }])
      }),
    )
  })
})
