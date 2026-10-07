import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Config, Effect, Redacted, Schema } from 'effect'
import { Pool } from 'pg'
import { openPgStorage } from '../../main.ts'

const decodeSchema = Schema.decodeUnknownSync(Schema.String)

/** Real host lifetime: awaiting disconnect attaches no timer or socket of its
 * own. Closing the storage and host pool must let Node exit without coercion. */
const main = Effect.scoped(
  Effect.gen(function* () {
    const url = Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL'))
    if (new URL(url).port === '55433') throw new Error('Refusing developer database')
    const schema = decodeSchema(process.argv[2])
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 })),
      (owned) => Effect.promise(() => owned.end()),
    )
    const storage = yield* Effect.acquireRelease(
      Effect.promise(() => openPgStorage(pool, schema)),
      (owned) => Effect.promise(() => owned.close(BACKGROUND_CONTEXT)),
    )
    void storage.disconnected.then(() => {
      process.exitCode = 1
    })
    yield* Effect.promise(() => storage.close(BACKGROUND_CONTEXT))
  }),
)
await Effect.runPromise(main)
