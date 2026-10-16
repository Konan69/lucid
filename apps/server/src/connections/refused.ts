import { inArray, like, or } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { Database } from '../database/client.ts'
import { refusedService, refusedServices, refusedHosts } from './curation.ts'
import { Executor } from './executor.ts'
import { removeConnection } from './migration.ts'
import { decodeRow } from './records.ts'
import { connections } from './tables.ts'

/**
 * Removes every Connection to a refused service through the same path a Person's Remove takes,
 * so its Executor app and account go with the row. Runs once at boot; a removal that fails is
 * logged and tried again at the next boot, and the refused service cannot be added meanwhile.
 */
export const removeRefused = Effect.fn('Connections.removeRefused')(function* () {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select()
      .from(connections)
      .where(
        or(
          inArray(connections.service, refusedServices),
          ...refusedHosts.map((host) => like(connections.service, `url:%${host}%`)),
        ),
      ),
  )
  for (const stored of rows) {
    if (!refusedService(stored.service)) continue
    const row = yield* decodeRow(stored)
    const removed = yield* removeConnection(row).pipe(Effect.result)
    yield* Effect.logInfo('Refused Integration removed').pipe(
      Effect.annotateLogs({ connectionId: row.id, removed: removed._tag === 'Success' }),
    )
  }
})

/** Forked into the server's scope like the migration worker: boot and health never wait on it. */
export const refusedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database
    const executor = yield* Executor
    yield* removeRefused().pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Executor, executor),
      Effect.catch((error) =>
        Effect.logError('Refused Integration removal failed', { reason: error._tag }),
      ),
      Effect.forkScoped,
    )
  }),
)
