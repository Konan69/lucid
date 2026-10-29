import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as Pg from 'pg'
import { describe, expect, layer } from '@effect/vitest'
import { Config, Context, Effect, Layer, Redacted, Schema } from 'effect'
import { InputAnswer, PersonId, SignalCue } from '@vivid/contracts'
import { Signal } from '../approvals/signal.ts'
import { DeliveryMessage } from '../threads/conversation.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'

const server = new URL('../../', import.meta.url)

/** Read each owner's actual generated SQL in migration order, without recreating its schema by hand. */
const migrations = (directory: string) =>
  NodeFS.readdirSync(new URL(directory, server))
    .toSorted()
    .map((name) => ({
      name,
      sql: NodeFS.readFileSync(new URL(`${directory}/${name}/migration.sql`, server), 'utf8'),
    }))

// Pin this upgrade's endpoints: later migrations must not run before these legacy rows are seeded.
const upgrade = ['20261010223657_input1', '20261010223658_input2', '20261010223659_input3'] as const
const previous = [...migrations('drizzle'), ...migrations('product-drizzle')].filter(
  (migration) => migration.name < upgrade[0],
)
const changed = upgrade.map((name) =>
  NodeFS.readFileSync(new URL(`product-drizzle/${name}/migration.sql`, server), 'utf8'),
)
const Rows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    questions: Schema.Json,
    answers: Schema.NullOr(Schema.Json),
    status: Schema.String,
    answered_by: Schema.NullOr(Schema.String),
    settled_at: Schema.NullOr(Schema.String),
    signal: Schema.Json,
  }),
)
const decodeRows = Schema.decodeUnknownEffect(Rows)

/** Scope the connection separately from database cleanup so PostgreSQL drops an already closed target. */
const connect = (url: string) => {
  const client = new Pg.Client({ connectionString: url })
  return Effect.acquireRelease(Effect.promise(() => client.connect()).pipe(Effect.as(client)), () =>
    Effect.promise(() => client.end()),
  )
}

const options = [{ label: 'Monday', detail: 'Start the week.' }]
const none = Signal.cases.None.make({})
const signal = Signal.cases.Owed.make({
  idempotencyKey: 'answer-chosen',
  deciderId: PersonId.make('migration-person'),
  message: DeliveryMessage.cases.Signal.make({
    cue: SignalCue.cases.Answer.make({ body: 'Monday' }),
  }),
})
const legacy = [
  { id: 'chosen', status: 'answered', answer: 'Monday', settled: 10, allows: false },
  { id: 'written', status: 'answered', answer: '  Tuesday  ', settled: 20, allows: true },
  { id: 'waiting', status: 'waiting', answer: null, settled: null, allows: true },
  { id: 'withdrawn', status: 'withdrawn', answer: null, settled: 30, allows: false },
]

/** The suite owns a real prior-schema connection and releases it before dropping its database. */
class PreviousDatabase extends Context.Service<PreviousDatabase, Pg.Client>()(
  'Inputs.test.PreviousDatabase',
) {}

/**
 * Prior-schema construction is fixture acquisition, not the upgrade under test. Build it in the
 * suite's scoped Layer so all historical DDL completes before the test's five-second budget.
 * This still replays every real migration from template0; acquisition failure fails the suite.
 */
const freshDatabase = Effect.fn('Inputs.test.migrationDatabase')(function* () {
  const supplied = Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL'))
  const address = new URL(supplied)
  const name = `${address.pathname.slice(1, 25)}_inputs_${NodeCrypto.randomBytes(8).toString('hex')}`
  const admin = yield* connect(supplied)
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`))
  address.pathname = `/${name}`
  const database = yield* connect(address.href)
  yield* Effect.promise(() => database.query(previous.map((migration) => migration.sql).join('\n')))
  return database
})

const previousDatabaseLayer = Layer.effect(PreviousDatabase, freshDatabase())

/** Seed both terminal states and owed delivery before any of the upgrade's generated SQL runs. */
const seedPrevious = Effect.fn('Inputs.test.seedPrevious')(function* (database: Pg.Client) {
  yield* Effect.promise(() =>
    database.query(
      `INSERT INTO "user" (id, name, email) VALUES ('migration-person', 'Ada', 'migration@example.test');
   INSERT INTO vivid_conversations (id, person_id, title, title_source, updated_at)
   VALUES ('migration-thread', 'migration-person', 'Migration', 'Person', 1);`,
    ),
  )
  for (const row of legacy)
    yield* Effect.promise(() =>
      database.query(
        `INSERT INTO vivid_input_requests
      (id, thread_id, person_id, question, options, allows_own_answer, status, answered_by, answer, settled_at, created_at, signal)
     VALUES ($1, 'migration-thread', 'migration-person', 'Which day?', $2, $3, $4, $5, $6, $7, 1, $8)`,
        [
          row.id,
          JSON.stringify(options),
          row.allows,
          row.status,
          row.status === 'answered' ? 'migration-person' : null,
          row.answer,
          row.settled,
          JSON.stringify(row.id === 'chosen' ? signal : none),
        ],
      ),
    )
})

/** Query persisted values after upgrade; compare meaning and verify the obsolete columns disappeared. */
const verifyUpgrade = Effect.fn('Inputs.test.verifyUpgrade')(function* (database: Pg.Client) {
  const result = yield* Effect.promise(() =>
    database.query(
      'SELECT id, questions, answers, status, answered_by, settled_at, signal FROM vivid_input_requests ORDER BY id',
    ),
  )
  expect(yield* decodeRows(result.rows)).toEqual([
    {
      id: 'chosen',
      questions: [{ question: 'Which day?', options, selection: 'One', allowsOwnAnswer: false }],
      answers: [InputAnswer.cases.Chosen.make({ labels: ['Monday'] })],
      status: 'answered',
      answered_by: 'migration-person',
      settled_at: '10',
      signal,
    },
    {
      id: 'waiting',
      questions: [{ question: 'Which day?', options, selection: 'One', allowsOwnAnswer: true }],
      answers: null,
      status: 'waiting',
      answered_by: null,
      settled_at: null,
      signal: none,
    },
    {
      id: 'withdrawn',
      questions: [{ question: 'Which day?', options, selection: 'One', allowsOwnAnswer: false }],
      answers: null,
      status: 'withdrawn',
      answered_by: null,
      settled_at: '30',
      signal: none,
    },
    {
      id: 'written',
      questions: [{ question: 'Which day?', options, selection: 'One', allowsOwnAnswer: true }],
      answers: [InputAnswer.cases.Written.make({ words: '  Tuesday  ' })],
      status: 'answered',
      answered_by: 'migration-person',
      settled_at: '20',
      signal: none,
    },
  ])
  const old = yield* Effect.promise(() =>
    database.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vivid_input_requests'
   AND column_name IN ('question', 'options', 'allows_own_answer', 'answer')`,
    ),
  )
  expect(old.rows).toEqual([])
})

/**
 * Start from template0 on explicit test authority, migrate both owners to the preceding state,
 * insert real legacy rows, then apply the generated expand/backfill/contract migrations. No
 * latest-schema template or reconstructed DDL can conceal a broken upgrade. Cleanup is registered
 * before CREATE DATABASE, and its name retains the gate's prefix for cleanup after termination.
 */
describe.skipIf(!testDatabaseConfigured)('Input request database upgrade', () => {
  layer(previousDatabaseLayer)('prior-schema fixture', (it) => {
    it.effect(
      'carries waiting, withdrawn, chosen, and written legacy records into ordered JSONB',
      () =>
        Effect.gen(function* () {
          const database = yield* PreviousDatabase
          yield* seedPrevious(database)
          yield* Effect.promise(() => database.query(changed.join('\n')))
          yield* verifyUpgrade(database)
        }),
    )
  })
})
