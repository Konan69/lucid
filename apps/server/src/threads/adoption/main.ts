import * as NodeFSP from 'node:fs/promises'
import { DatabaseFailure, RuntimeHistoryMap } from '@vivid/contracts'
import { Config, Effect, Layer, Schema } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import { layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import { makeWithDefaults } from 'drizzle-orm/effect-postgres'
import { Database, mapDriverErrors } from '../../database/client.ts'
import { postgresCodecs } from '../../database/codecs.ts'
import { adoptRuns } from '../adopt.ts'

/** This command requires only its product database, without starting server workers or providers. */
const database = Layer.effect(
  Database,
  Effect.gen(function* () {
    const raw = yield* makeWithDefaults()
    return Database.of({
      _: raw._,
      query: raw.query,
      $with: raw.$with.bind(raw),
      $cache: raw.$cache,
      $count: raw.$count.bind(raw),
      with: raw.with.bind(raw),
      select: raw.select.bind(raw),
      selectDistinct: raw.selectDistinct.bind(raw),
      selectDistinctOn: raw.selectDistinctOn.bind(raw),
      update: raw.update.bind(raw),
      insert: raw.insert.bind(raw),
      delete: raw.delete.bind(raw),
      refreshMaterializedView: raw.refreshMaterializedView.bind(raw),
      execute: raw.execute.bind(raw),
      run: mapDriverErrors,
      transaction: (use) => mapDriverErrors(raw.transaction(use)),
    })
  }),
).pipe(
  Layer.provide(
    Layer.unwrap(
      Config.Redacted('DATABASE_URL').pipe(
        Effect.map((url) =>
          pgClientLayer({ url, applicationName: 'vivid-runs-adopt', types: postgresCodecs() }),
        ),
      ),
    ),
  ),
)

/** Decode the complete map before the first write. Failure output never prints input or URLs. */
const decodeMap = Schema.decodeEffect(Schema.fromJsonString(RuntimeHistoryMap))

const command = Effect.gen(function* () {
  const [file, ...extra] = process.argv.slice(2)
  if (file === undefined || extra.length > 0)
    return yield* new DatabaseFailure({ message: 'Usage: runs:adopt <map.json>' })
  const json = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(file, 'utf8'),
    catch: () => new DatabaseFailure({ message: 'History map could not be read' }),
  })
  const map = yield* decodeMap(json).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'History map is invalid' })),
  )
  const changed = yield* adoptRuns(map)
  yield* Effect.logInfo('Run receipts adopted', { changed })
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off -- This CLI is the application entry point and owns its database scope.
  Effect.provide(database),
  Effect.scoped,
  Effect.catch((error) =>
    Effect.logError('Run receipt adoption failed', error).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
)
NodeRuntime.runMain(command)
