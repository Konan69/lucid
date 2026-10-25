import * as Pg from 'pg'
import { Context, Effect, Layer, Redacted } from 'effect'
import { RuntimeSettings } from '../src/settings.ts'
import { Stores, storesLayer } from '../src/storage/stores.ts'

/**
 * The production Stores Layer on one database, for the life of the enclosing scope: what one
 * runtime process holds, without its Persons. Closing the scope is that process stopping.
 */
export const storesOn = (database: string) =>
  Layer.build(
    storesLayer.pipe(
      Layer.provide(
        Layer.succeed(
          RuntimeSettings,
          RuntimeSettings.of({
            databaseUrl: Redacted.make(database),
            notesDirectory: '/fixture/notes',
            token: Redacted.make('fixture-runtime-token'),
            serverUrl: new URL('http://server.invalid'),
            idleMillis: 60_000,
            host: '127.0.0.1',
            port: 0,
          }),
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Stores)))

/** What the cases' own queries select: text, numbers, flags and null. */
type Scalar = string | number | boolean | null

/** One statement on a connection of its own, as an operator would run it; its rows. */
export const query = (database: string, statement: string, params: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => {
    const client = new Pg.Client({ connectionString: database })
    return client
      .connect()
      .then(() => client.query(statement, [...params]))
      .then((result): ReadonlyArray<Readonly<Record<string, Scalar>>> => result.rows)
      .finally(() => client.end())
  })

/**
 * End the backend that holds the runtime's advisory lock in this database: what a network
 * failure or a database restart does to the control connection.
 */
export const dropControl = (database: string) =>
  query(
    database,
    `SELECT pg_terminate_backend(pid) AS ended FROM pg_locks
     WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  )
