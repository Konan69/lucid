import { Effect } from 'effect'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Pool, types, type PoolConfig } from 'pg'
import * as Option from 'effect/Option'
import { describe, expect, it } from '@effect/vitest'
import { onTestFinished } from 'vitest'
import { openPgDatabase, openPgStorage } from './pg.ts'
import { applyPostgresMigrations } from './migrations.ts'
import { postgresFixture, rejected } from './testing.ts'
const context = BACKGROUND_CONTEXT
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
describe.skipIf(Option.isNone(testUrl))('PostgreSQL migrations and facade', () => {
  /** Pi migrations.ts:INITIAL_SCHEMA/applySqliteMigrations, fresh schema and no-op reopen. */
  it.live('creates the schema and reopens without changing metadata or its tables', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const first = yield* Effect.promise(() => fixture.open())
      const id = yield* Effect.promise(() => first.mintId<ConversationId>())
      yield* Effect.promise(() => first.commit([{ type: 'conversation', value: { id } }], context))
      yield* Effect.promise(() => first.close(context))
      const before = yield* Effect.promise(() =>
        fixture.pool.query(`SELECT * FROM "${fixture.schema}".durable_metadata`),
      )
      const reopened = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => reopened.conversation(id, context))).toEqual({ id })
      expect(
        (yield* Effect.promise(() =>
          fixture.pool.query(`SELECT * FROM "${fixture.schema}".durable_metadata`),
        )).rows,
      ).toEqual(before.rows)
      const tables = yield* Effect.promise(() =>
        fixture.pool.query<{
          tablename: string
        }>('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [
          fixture.schema,
        ]),
      )
      expect(tables.rows.map((row) => row.tablename)).toEqual([
        'conversations',
        'document_revisions',
        'documents',
        'durable_metadata',
        'durable_schema',
        'entries',
        'record_ids',
        'submissions',
        'tasks',
      ])
    }),
  )
  /** Pi applySqliteMigrations refuses a database newer than its contiguous history. */
  it.live('refuses newer versions and releases its connection without ending the pool', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      yield* Effect.flatMap(
        Effect.promise(() => fixture.open()),
        (_await0) => Effect.promise(() => _await0.close(context)),
      )
      yield* Effect.promise(() =>
        fixture.pool.query(`UPDATE "${fixture.schema}".durable_schema SET version = 2`),
      )
      expect((yield* rejected(() => fixture.open())).raise).toThrow(
        'Durable PostgreSQL schema version 2 is newer than supported version 1',
      )
      expect(
        (yield* Effect.promise(() =>
          fixture.pool.query(`SELECT version FROM "${fixture.schema}".durable_schema`),
        )).rows,
      ).toEqual([{ version: '2' }])
    }),
  )
  /** Namespace is the PostgreSQL addition; colliding Pi numeric ids remain isolated. */
  it.live('isolates two schemas in the same database', () =>
    Effect.gen(function* () {
      const one = postgresFixture(Option.getOrThrow(testUrl))
      const two = postgresFixture(Option.getOrThrow(testUrl))
      const left = yield* Effect.promise(() => one.open())
      const rightOwner = yield* Effect.promise(() => two.open())
      const id = yield* Effect.promise(() => left.mintId<ConversationId>())
      yield* Effect.promise(() => left.commit([{ type: 'conversation', value: { id } }], context))
      expect(yield* Effect.promise(() => rightOwner.conversation(id, context))).toBeUndefined()
      expect(yield* Effect.promise(() => rightOwner.mintId<ConversationId>())).toBe(id)
    }),
  )
  /** Validation precedes even acquiring a driver connection. An already ended real
   * Pool would reject SQL/connect with a different error; no mock is used. */
  it.live('refuses invalid names before reaching the pool', () =>
    Effect.gen(function* () {
      const pool = new Pool({ connectionString: Option.getOrThrow(testUrl) })
      yield* Effect.promise(() => pool.end())
      for (const name of ['', 'x.y', 'x; DROP SCHEMA public', 'é', 'x'.repeat(64)]) {
        expect((yield* rejected(() => openPgStorage(pool, name))).raise).toThrow('plain identifier')
      }
    }),
  )
  /** Pi applies all pending migrations in one transaction, including namespace
   * creation. Failed DDL leaves no namespace or schema-version row behind. */
  it.live('rolls back failed migrations and refuses noncontiguous history', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
      onTestFinished(() => db.close())
      try {
        expect(
          (yield* rejected(() =>
            applyPostgresMigrations(db, fixture.schema, [{ version: 2, statements: [] }]),
          )).raise,
        ).toThrow('contiguous versions starting at 1')
        expect(
          (yield* rejected(() =>
            applyPostgresMigrations(db, fixture.schema, [
              {
                version: 1,
                statements: ['CREATE TABLE incomplete (id INTEGER)', 'SELECT missing_column'],
              },
            ]),
          )).raise,
        ).toThrow('missing_column')
        expect(
          (yield* Effect.promise(() =>
            fixture.pool.query('SELECT nspname FROM pg_namespace WHERE nspname = $1', [
              fixture.schema,
            ]),
          )).rows,
        ).toEqual([])
      } finally {
        yield* Effect.promise(() => db.close())
      }
    }),
  )
  /** Pi database.ts:SqliteDatabase/node.ts:NodeSqliteTransaction: a transaction
   * queues unrelated reads, invalidates its handle and returns the same error. */
  it.live('serializes transactions, rolls back before rejection, and invalidates handles', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const storage = yield* Effect.promise(() => fixture.open())
      yield* Effect.promise(() => storage.close(context))
      const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
      onTestFinished(() => db.close())
      try {
        const failure = new Error('callback failed')
        let outside: Promise<
          Option.Option<{
            next_seq: string
          }>
        > = Promise.resolve(Option.none())
        const transaction = db.transaction((handle) =>
          handle
            .run('UPDATE durable_metadata SET next_seq = ?', 9)
            .then(() => {
              outside = db.get('SELECT next_seq FROM durable_metadata')
              return handle.run('UPDATE durable_metadata SET next_seq = ?', 10)
            })
            .then(() => handle),
        )
        const handle = yield* Effect.promise(() => transaction)
        expect(Option.getOrThrow(yield* Effect.promise(() => outside))).toEqual({ next_seq: '10' })
        expect((yield* rejected(() => handle.exec('SELECT 1'))).raise).toThrow('no longer active')
        expect(
          (yield* rejected(() =>
            db.transaction((tx) =>
              tx.run('UPDATE durable_metadata SET next_seq = ?', 20).then(() => {
                throw failure
              }),
            ),
          )).cause,
        ).toBe(failure)
        expect(
          Option.getOrThrow(
            yield* Effect.promise(() => db.get('SELECT next_seq FROM durable_metadata')),
          ),
        ).toEqual({
          next_seq: '10',
        })
      } finally {
        yield* Effect.promise(() => db.close())
      }
    }),
  )
  /** PostgreSQL's asynchronous leased client can fail while idle. The facade
   * must retain Pi's AggregateError distinction when a rollback cannot execute. */
  it.live(
    'distinguishes failed rollback from a callback error using a real disconnected connection',
    () =>
      Effect.gen(function* () {
        const fixture = postgresFixture(Option.getOrThrow(testUrl))
        yield* Effect.flatMap(
          Effect.promise(() => fixture.open()),
          (_await1) => Effect.promise(() => _await1.close(context)),
        )
        const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
        onTestFinished(() => db.close())
        const failure = new Error('callback failed after disconnect')
        const result = db.transaction((tx) =>
          tx
            .get<{
              pid: number
            }>('SELECT pg_backend_pid() AS pid')
            .then((row) =>
              fixture.pool.query('SELECT pg_terminate_backend($1)', [Option.getOrThrow(row).pid]),
            )
            .then(() =>
              tx.exec('SELECT 1').catch(() => {
                throw failure
              }),
            )
            .then(() => {
              throw failure
            }),
        )
        expect((yield* rejected(() => result)).cause).toBeInstanceOf(AggregateError)
        expect((yield* rejected(() => result)).cause).toMatchObject({
          errors: [failure, expect.any(Error)],
        })
      }),
  )
  /** Per-query parsers must override a host's supported (but lossy) INT8 parser.
   * A real Pool supplies that configuration; no global parser is mutated. */
  it.live.each([false, true])(
    'retains BIGINT text with a host number parser (binary=%s) and restores search_path',
    (binary) =>
      Effect.gen(function* () {
        const fixture = postgresFixture(Option.getOrThrow(testUrl))
        // pg/lib/client.js:Client.constructor publicly accepts binary, while the
        // pinned @types/pg PoolConfig omits it. Declare that verified config field
        // locally, without casting or modifying the driver or its global defaults.
        const configuration = {
          connectionString: Option.getOrThrow(testUrl),
          max: 1,
          binary,
          types: {
            getTypeParser: (oid, format) =>
              oid === types.builtins.INT8 ? Number : types.getTypeParser(oid, format),
          },
        } satisfies PoolConfig & {
          readonly binary: boolean
        }
        const pool = new Pool(configuration)
        onTestFinished(() => pool.end())
        const original = yield* Effect.promise(() =>
          pool.query<{
            search_path: string
          }>('SHOW search_path'),
        )
        const db = yield* Effect.promise(() => openPgDatabase(pool, fixture.schema))
        onTestFinished(() => db.close())
        try {
          expect(
            Option.getOrThrow(
              yield* Effect.promise(() => db.get('SELECT ?::bigint AS id', '9007199254740993')),
            ),
          ).toEqual({
            id: '9007199254740993',
          })
        } finally {
          yield* Effect.promise(() => db.close())
        }
        expect((yield* Effect.promise(() => pool.query('SHOW search_path'))).rows).toEqual(
          original.rows,
        )
      }),
  )
})
