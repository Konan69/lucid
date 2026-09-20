import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { Pool } from 'pg'
import { bootstrapConnectorSchema } from './migration.ts'

/** Disposable migration-test database configuration is unsafe or unavailable. */
class MigrationTestDatabaseInvalid extends Schema.TaggedError<MigrationTestDatabaseInvalid>()(
  'MigrationTestDatabaseInvalid',
  { message: Schema.String },
  { title: 'Connector migration test database invalid' },
) {}

const decodeDatabaseUrl = Schema.decodeUnknownEffect(Schema.URLFromString)

/** `describe.skipIf` requires the test-only configuration decision synchronously. */
const testDatabaseConfigured = Option.isSome(
  // oxlint-disable-next-line vivid/no-runpromise-in-library, vivid/no-manual-effect-runtime-in-tests -- Vitest suite declaration requires a synchronous skip condition.
  Effect.runSync(Config.option(Config.Redacted('VIVID_TEST_DATABASE_URL'))),
)

/** Runs one PostgreSQL test-adapter operation without exposing connection details. */
const databaseOperation = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new MigrationTestDatabaseInvalid({ message: `Test database ${operation} failed` }),
  })

/** Rejects the developer database before opening a connection. */
const readDisposableDatabaseUrl = Effect.fn('ConnectorMigrationTest.readDatabaseUrl')(function* () {
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
})

/** Owns a pool for the surrounding test scope. */
const acquirePool = (url: URL) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url.toString() })),
    Effect.fn('ConnectorMigrationTest.closePool')((pool) =>
      databaseOperation('pool close', () => pool.end()).pipe(Effect.ignore),
    ),
  )

/** Drops the unique test database even when bootstrap or assertions fail. */
const dropDatabase = Effect.fn('ConnectorMigrationTest.dropDatabase')(function* (
  adminPool: Pool,
  databaseName: string,
) {
  // SAFETY: databaseName is generated from a UUID with hyphens removed and contains only ASCII alphanumerics.
  yield* databaseOperation('cleanup', () =>
    adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
  ).pipe(Effect.ignore)
})

describe.skipIf(!testDatabaseConfigured)('connector schema migration', () => {
  it.effect('serializes concurrent first-boot schema bootstrap', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseUrl = yield* readDisposableDatabaseUrl()
        const databaseName = `vivid_connector_bootstrap_${NodeCrypto.randomUUID().replaceAll('-', '')}`
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
        yield* Effect.all(
          [bootstrapConnectorSchema(firstPool), bootstrapConnectorSchema(secondPool)],
          { concurrency: 2 },
        )

        const tables = yield* databaseOperation('verification', () =>
          firstPool.query("SELECT to_regclass('public.vivid_credentials') AS credentials"),
        )
        expect(tables.rows[0]).toMatchObject({ credentials: 'vivid_credentials' })
      }),
    ),
  )
})
