import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as Pg from 'pg'
import { Effect } from 'effect'
import { afterAll, inject } from 'vitest'

/** Close the teardown connection before restoring the worker's original database authority. */
const restoreDatabase = Effect.fn('TestDatabase.restoreWorker')(function* (
  cleanup: Pg.Client,
  supplied: string,
) {
  yield* Effect.promise(() => cleanup.end())
  NodeProcess.env.VIVID_TEST_DATABASE_URL = supplied
})

/** The worker teardown drops only its captured clone, even if a test changed its environment. */
const dropDatabase = Effect.fn('TestDatabase.dropWorker')(function* (
  supplied: string,
  name: string,
) {
  const cleanup = new Pg.Client({ connectionString: supplied })
  yield* Effect.promise(() => cleanup.connect())
  yield* Effect.promise(() => cleanup.query(`DROP DATABASE IF EXISTS "${name}"`)).pipe(
    Effect.ensuring(restoreDatabase(cleanup, supplied)),
  )
})

/** Vitest awaits this hook after the file's Effect scopes have closed their database pools. */
function teardown(supplied: string, name: string) {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Vitest's worker afterAll hook is the process entry for database teardown.
  return Effect.runPromise(dropDatabase(supplied, name))
}

/**
 * UUID rows alone cannot isolate global scheduler/replay scans. Give each file its own migrated
 * database before importing stores, while retaining normal fixture cleanup within the file.
 * Register teardown before creation; Effect test/layer scopes close their pools before afterAll.
 */
const prepareDatabase = Effect.fn('TestDatabase.prepareWorker')(function* (supplied: string) {
  const template = inject('serverDatabaseTemplate')
  // PostgreSQL identifiers have a 63-byte limit; the invocation prefix (at most 33 bytes) plus
  // 64 random bits fits.
  const name = `${inject('serverDatabasePrefix')}_${NodeCrypto.randomBytes(8).toString('hex')}`
  const admin = new Pg.Client({ connectionString: supplied })
  yield* Effect.promise(() => admin.connect())
  afterAll(() => teardown(supplied, name))
  yield* Effect.gen(function* () {
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`))
    const target = new URL(supplied)
    target.pathname = `/${name}`
    NodeProcess.env.VIVID_TEST_DATABASE_URL = target.href
  }).pipe(Effect.ensuring(Effect.promise(() => admin.end())))
})

const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
if (supplied !== undefined) {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Vitest awaits this worker setup module before importing any server suite.
  await Effect.runPromise(prepareDatabase(supplied))
}
