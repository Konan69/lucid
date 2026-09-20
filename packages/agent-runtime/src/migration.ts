import * as NodeURL from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { Pool, PoolClient } from 'pg'

const runtimeSchemaLockId = 741_936_218
const migrationsFolder = NodeURL.fileURLToPath(new URL('../drizzle', import.meta.url))

const SchemaRegistration = Schema.Struct({ name: Schema.NullOr(Schema.String) })
const SchemaVersion = Schema.Struct({ version: Schema.Union([Schema.String, Schema.Number]) })
const decodeSchemaRegistration = Schema.decodeUnknownSync(SchemaRegistration)
const decodeSchemaVersion = Schema.decodeUnknownSync(SchemaVersion)

/** Runtime schema bootstrap failed at one PostgreSQL operation. */
export class RuntimeSchemaBootstrapFailed extends Schema.TaggedError<RuntimeSchemaBootstrapFailed>()(
  'RuntimeSchemaBootstrapFailed',
  {
    operation: Schema.String,
    message: Schema.String,
  },
  { title: 'Runtime schema bootstrap failed' },
) {}

interface DatabaseOperation<A> {
  readonly operation: string
  readonly run: () => PromiseLike<A>
}

/** Keeps raw PostgreSQL failures inside the migration adapter. */
const databaseOperation = <A>({ operation, run }: DatabaseOperation<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new RuntimeSchemaBootstrapFailed({
        operation,
        message: `Runtime schema bootstrap failed during ${operation}`,
      }),
  })

/** Acquires one dedicated pooled session for the complete bootstrap critical section. */
const acquireClient = Effect.fn('RuntimeSchema.acquireClient')(function* (pool: Pool) {
  return yield* databaseOperation({
    operation: 'acquire-client',
    run: () => pool.connect(),
  })
})

/** Releases the session lock and always returns the pooled client. */
const releaseClient = Effect.fn('RuntimeSchema.releaseClient')(function* (client: PoolClient) {
  yield* databaseOperation({
    operation: 'release-lock',
    run: () => client.query('SELECT pg_advisory_unlock($1)', [runtimeSchemaLockId]),
  }).pipe(Effect.ignore)
  client.release()
})

/** Applies compatibility changes for databases created before the Drizzle migration owner. */
const applyCompatibilityChanges = Effect.fn('RuntimeSchema.applyCompatibilityChanges')(function* (
  client: PoolClient,
) {
  const latest = yield* databaseOperation({
    operation: 'read-compatibility-version',
    run: () =>
      client.query('SELECT version FROM vivid_schema_migrations ORDER BY version DESC LIMIT 1'),
  })
  const row = latest.rows[0]
  const version = row === undefined ? 0 : Number(decodeSchemaVersion(row).version)
  if (version >= 2) return

  const statements = [
    'ALTER TABLE vivid_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE vivid_follow_ups ADD COLUMN IF NOT EXISTS submission_id TEXT',
    'ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS next_expected_at BIGINT',
    'ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS last_missed_at BIGINT',
    'ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS library_folder_id TEXT',
    'ALTER TABLE vivid_library_documents ADD COLUMN IF NOT EXISTS folder_id TEXT',
    "ALTER TABLE vivid_library_chunks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED",
    'CREATE INDEX IF NOT EXISTS vivid_library_documents_folder ON vivid_library_documents(folder_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS vivid_library_chunks_search ON vivid_library_chunks USING GIN(search_vector)',
  ]
  yield* Effect.forEach(statements, (statement) =>
    databaseOperation({
      operation: 'apply-compatibility-change',
      run: () => client.query(statement),
    }),
  )
  yield* databaseOperation({
    operation: 'record-compatibility-version',
    run: () =>
      client.query(
        'INSERT INTO vivid_schema_migrations(version, applied_at) VALUES (2, $1) ON CONFLICT (version) DO NOTHING',
        [Date.now()],
      ),
  })
})

/**
 * Serializes schema detection, Drizzle migration, and compatibility changes on one PostgreSQL session.
 */
export const bootstrapRuntimeSchema = Effect.fn('RuntimeSchema.bootstrap')(function* (pool: Pool) {
  return yield* Effect.acquireUseRelease(
    acquireClient(pool),
    Effect.fn('RuntimeSchema.useClient')(function* (client) {
      yield* databaseOperation({
        operation: 'acquire-lock',
        run: () => client.query('SELECT pg_advisory_lock($1)', [runtimeSchemaLockId]),
      })
      const existing = yield* databaseOperation({
        operation: 'detect-schema',
        run: () => client.query("SELECT to_regclass('public.vivid_conversations') AS name"),
      })
      const registration = decodeSchemaRegistration(existing.rows[0])
      if (registration.name === null) {
        const lockedDatabase = drizzle({ client })
        const migrationResult = yield* databaseOperation({
          operation: 'migrate',
          run: () => migrate(lockedDatabase, { migrationsFolder }),
        })
        if (migrationResult !== undefined) {
          yield* Effect.fail(
            new RuntimeSchemaBootstrapFailed({
              operation: 'migrate',
              message: `Runtime migration initialization failed: ${migrationResult.exitCode}`,
            }),
          )
        }
      }
      yield* applyCompatibilityChanges(client)
    }),
    releaseClient,
  )
})
