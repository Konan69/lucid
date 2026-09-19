import * as NodeURL from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { Pool, PoolClient } from 'pg'

const connectorSchemaLockId = 741_936_219
const migrationsFolder = NodeURL.fileURLToPath(new URL('../drizzle', import.meta.url))
const SchemaRegistration = Schema.Struct({ name: Schema.NullOr(Schema.String) })
const decodeSchemaRegistration = Schema.decodeUnknownSync(SchemaRegistration)

/** Connector schema bootstrap failed at one PostgreSQL operation. */
export class ConnectorSchemaBootstrapFailed extends Schema.TaggedError<ConnectorSchemaBootstrapFailed>()(
  'ConnectorSchemaBootstrapFailed',
  {
    operation: Schema.String,
    message: Schema.String,
  },
  { title: 'Connector schema bootstrap failed' },
) {}

interface DatabaseOperation<A> {
  readonly operation: string
  readonly run: () => PromiseLike<A>
}

const databaseOperation = <A>({ operation, run }: DatabaseOperation<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new ConnectorSchemaBootstrapFailed({
        operation,
        message: `Connector schema bootstrap failed during ${operation}`,
      }),
  })

const acquireClient = Effect.fn('ConnectorSchema.acquireClient')(function* (pool: Pool) {
  return yield* databaseOperation({
    operation: 'acquire-client',
    run: () => pool.connect(),
  })
})

const releaseClient = Effect.fn('ConnectorSchema.releaseClient')(function* (client: PoolClient) {
  yield* databaseOperation({
    operation: 'release-lock',
    run: () => client.query('SELECT pg_advisory_unlock($1)', [connectorSchemaLockId]),
  }).pipe(Effect.ignore)
  client.release()
})

/** Serializes connector schema detection and Drizzle migration on one PostgreSQL session. */
export const bootstrapConnectorSchema = Effect.fn('ConnectorSchema.bootstrap')(function* (
  pool: Pool,
) {
  return yield* Effect.acquireUseRelease(
    acquireClient(pool),
    Effect.fn('ConnectorSchema.useClient')(function* (client) {
      yield* databaseOperation({
        operation: 'acquire-lock',
        run: () => client.query('SELECT pg_advisory_lock($1)', [connectorSchemaLockId]),
      })
      const existing = yield* databaseOperation({
        operation: 'detect-schema',
        run: () => client.query("SELECT to_regclass('public.vivid_credentials') AS name"),
      })
      const registration = decodeSchemaRegistration(existing.rows[0])
      if (registration.name === null) {
        const migrationResult = yield* databaseOperation({
          operation: 'migrate',
          run: () => migrate(drizzle({ client }), { migrationsFolder }),
        })
        if (migrationResult !== undefined) {
          yield* Effect.fail(
            new ConnectorSchemaBootstrapFailed({
              operation: 'migrate',
              message: `Connector migration initialization failed: ${migrationResult.exitCode}`,
            }),
          )
        }
      }
    }),
    releaseClient,
  )
})
