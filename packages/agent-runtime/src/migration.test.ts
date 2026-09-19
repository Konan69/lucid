import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { Pool } from 'pg'
import { bootstrapRuntimeSchema } from './migration.ts'
import { testDatabaseConfigured } from './testdb.ts'

/** Disposable migration-test database configuration is unsafe or unavailable. */
class MigrationTestDatabaseInvalid extends Schema.TaggedError<MigrationTestDatabaseInvalid>()(
  'MigrationTestDatabaseInvalid',
  { message: Schema.String },
  { title: 'Migration test database invalid' },
) {}

const decodeDatabaseUrl = Schema.decodeUnknownEffect(Schema.URLFromString)

/** Runs one PostgreSQL test-adapter operation without leaking its connection details. */
const databaseOperation = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new MigrationTestDatabaseInvalid({ message: `Test database ${operation} failed` }),
  })

/** Rejects the developer database before opening a connection. */
const readDisposableDatabaseUrl = Effect.fn('MigrationTest.readDisposableDatabaseUrl')(
  function* () {
    const redacted = yield* Config.Redacted('VIVID_TEST_DATABASE_URL')
    const url = yield* decodeDatabaseUrl(Redacted.value(redacted)).pipe(
      Effect.mapError(
        () => new MigrationTestDatabaseInvalid({ message: 'VIVID_TEST_DATABASE_URL is invalid' }),
      ),
    )
    if (url.port === '55433') {
      return yield* Effect.fail(
        new MigrationTestDatabaseInvalid({
          message: 'VIVID_TEST_DATABASE_URL must not target the developer database on port 55433',
        }),
      )
    }
    return url
  },
)

/** Owns a pool for the surrounding test scope. */
const acquirePool = (url: URL) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url.toString() })),
    Effect.fn('MigrationTest.closePool')((pool) =>
      databaseOperation('pool close', () => pool.end()).pipe(Effect.ignore),
    ),
  )

/** Drops a unique test database even when bootstrap or assertions fail. */
const dropDatabase = Effect.fn('MigrationTest.dropDatabase')(function* (
  adminPool: Pool,
  databaseName: string,
) {
  // SAFETY: databaseName is generated from a UUID with hyphens removed and contains only ASCII alphanumerics.
  yield* databaseOperation('cleanup', () =>
    adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
  ).pipe(Effect.ignore)
})

describe.skipIf(!testDatabaseConfigured)('runtime schema migration', () => {
  it.effect('serializes concurrent first-boot schema bootstrap', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseUrl = yield* readDisposableDatabaseUrl()
        const databaseName = `vivid_bootstrap_${NodeCrypto.randomUUID().replaceAll('-', '')}`
        const targetUrl = new URL(baseUrl)
        targetUrl.pathname = `/${databaseName}`

        const adminPool = yield* acquirePool(baseUrl)
        yield* Effect.addFinalizer(() => dropDatabase(adminPool, databaseName))
        // SAFETY: databaseName is generated from a UUID with hyphens removed and contains only ASCII alphanumerics.
        yield* databaseOperation('creation', () =>
          adminPool.query(`CREATE DATABASE "${databaseName}"`),
        )

        const firstPool = yield* acquirePool(targetUrl)
        const secondPool = yield* acquirePool(targetUrl)
        yield* Effect.all([bootstrapRuntimeSchema(firstPool), bootstrapRuntimeSchema(secondPool)], {
          concurrency: 2,
        })

        const tables = yield* databaseOperation('verification', () =>
          firstPool.query(
            "SELECT to_regclass('public.vivid_conversations') AS conversations, to_regclass('public.vivid_schema_migrations') AS versions",
          ),
        )
        expect(tables.rows[0]).toMatchObject({
          conversations: 'vivid_conversations',
          versions: 'vivid_schema_migrations',
        })
      }),
    ),
  )
})
