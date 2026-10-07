import { Effect } from 'effect'
import {
  ROOT_CONVERSATION_ID,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type DocumentId,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import * as Option from 'effect/Option'
import { describe, expect, it } from '@effect/vitest'
import { Pool } from 'pg'
import { onTestFinished } from 'vitest'
import { StorageOwned, StorageDisconnected } from './main.ts'
import { openPgDatabase, openPgStorage } from './pg.ts'
import { PostgresStorage } from './storage.ts'
import { postgresFixture, rejected } from './testing.ts'
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
const context = BACKGROUND_CONTEXT
describe.skipIf(Option.isNone(testUrl))('PostgreSQL single ownership', () => {
  /** Review11c C: a max=1 Pool is exhausted by a storage's lifetime lease.
   * The host's connectionTimeoutMillis bounds that wait; the adapter neither
   * changes the pool's capacity nor borrows another backend behind its owner. */
  it.live('honors the host connection timeout on an exhausted pool', () =>
    Effect.gen(function* () {
      const pool = new Pool({
        connectionString: Option.getOrThrow(testUrl),
        max: 1,
        connectionTimeoutMillis: 1000,
      })
      onTestFinished(() => pool.end())
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const storage = yield* Effect.promise(() => openPgStorage(pool, fixture.schema))
      fixture.track(storage)
      expect((yield* rejected(() => openPgStorage(pool, fixture.schema))).raise).toThrow(
        'timeout exceeded when trying to connect',
      )
      yield* Effect.promise(() => storage.close(context))
      expect((yield* Effect.promise(() => pool.query('SELECT 1 AS usable'))).rows).toEqual([
        { usable: 1 },
      ])
    }),
  )
  /** Review11c A: the backend owns both the session lock and all commits. Losing
   * it must fence even mintId, retain the original cause, and require reopen. */
  it.live('fences every storage operation with one typed disconnection', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
      const storage = yield* Effect.promise(() => PostgresStorage.open(db, fixture.schema))
      fixture.track(storage)
      const pid = Option.getOrThrow(
        yield* Effect.promise(() =>
          db.get<{
            pid: number
          }>('SELECT pg_backend_pid() AS pid'),
        ),
      ).pid
      const entryId = yield* Effect.promise(() => storage.mintId<EntryId>())
      const taskId = yield* Effect.promise(() => storage.mintId<TaskId<JsonValue>>())
      const submissionId = yield* Effect.promise(() => storage.mintId<SubmissionId>())
      const documentId = yield* Effect.promise(() => storage.mintId<DocumentId>())
      yield* Effect.promise(() =>
        fixture.pool.query('SELECT pg_terminate_backend($1, 1000)', [pid]),
      )
      const disconnected = (yield* rejected(() => storage.mintId())).cause
      expect(disconnected).toBeInstanceOf(StorageDisconnected)
      if (!(disconnected instanceof StorageDisconnected))
        throw new Error('Expected a disconnected storage')
      expect(disconnected.schema).toBe(fixture.schema)
      expect(disconnected.cause).toBeInstanceOf(Error)
      const calls = [
        () => storage.commit([], context),
        () => storage.mintId(),
        () => storage.scanConversations({}, 1, undefined, context),
        () => storage.conversation(ROOT_CONVERSATION_ID, context),
        () => storage.entry(entryId, context),
        () => storage.entry(ROOT_CONVERSATION_ID, entryId, context),
        () => storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1, undefined, context),
        () => storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context),
        () => storage.task(taskId, context),
        () => storage.submission(submissionId, context),
        () => storage.submissionByRequest(ROOT_CONVERSATION_ID, 'request', context),
        () =>
          storage.findDocument(
            { kind: 'document', scope: { kind: 'session' } },
            'current',
            context,
          ),
        () => storage.document(documentId, 'current', context),
        () => storage.scanTasks({}, 1, undefined, context),
        () => storage.scanSubmissions({}, 1, undefined, context),
      ]
      for (const call of calls)
        expect((yield* rejected<Awaited<ReturnType<typeof call>>>(() => call())).cause).toBe(
          disconnected,
        )
      yield* Effect.promise(() => storage.close(context))
      const reopened = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => reopened.commit([], context))).toBe(1)
    }),
  )
  /** A second lease cannot run migrations or mint against an active owner's
   * schema. close must unlock even though the pooled backend remains alive. */
  it.live('refuses a second owner and admits it after the first closes', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const first = yield* Effect.promise(() => fixture.open())
      const failure = fixture.open()
      expect((yield* rejected(() => failure)).cause).toBeInstanceOf(StorageOwned)
      expect((yield* rejected(() => failure)).cause).toMatchObject(
        new StorageOwned({ schema: fixture.schema }),
      )
      yield* Effect.promise(() => first.close(context))
      const next = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => next.commit([], context))).toBe(1)
    }),
  )
  /** pg_terminate_backend(pid, milliseconds) waits for the targeted backend's
   * death on PostgreSQL 18. This is a database completion signal, not polling.
   * The original facade remains open: PostgreSQL itself must release its lock. */
  it.live('admits a new owner after the owning backend dies', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
      const first = yield* Effect.promise(() => PostgresStorage.open(db, fixture.schema))
      fixture.track(first)
      const pid = Option.getOrThrow(
        yield* Effect.promise(() =>
          db.get<{
            pid: number
          }>('SELECT pg_backend_pid() AS pid'),
        ),
      ).pid
      expect(
        (yield* Effect.promise(() =>
          fixture.pool.query('SELECT pg_terminate_backend($1, 1000) AS stopped', [pid]),
        )).rows,
      ).toEqual([{ stopped: true }])
      const next = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => next.commit([], context))).toBe(1)
      expect((yield* rejected(() => db.exec('SELECT 1'))).raise).toThrow()
      yield* Effect.promise(() => first.close(context))
    }),
  )
  /** Distinct schema names have distinct stable advisory keys within the same
   * database; acquiring one must leave the other independently usable. */
  it.live('allows simultaneous owners of different schemas', () =>
    Effect.gen(function* () {
      const one = postgresFixture(Option.getOrThrow(testUrl))
      const two = postgresFixture(Option.getOrThrow(testUrl))
      const left = yield* Effect.promise(() => one.open())
      const right = yield* Effect.promise(() => two.open())
      expect(yield* Effect.promise(() => left.commit([], context))).toBe(1)
      expect(yield* Effect.promise(() => right.commit([], context))).toBe(1)
    }),
  )
  /** Race two real leases before a schema exists. The nonblocking ownership
   * guard must produce exactly one winner and one StorageOwned, before the
   * losing lease can reach CREATE SCHEMA and produce a raw pg_namespace 23505. */
  it.live('guards concurrent first opens before migrations', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const results = yield* Effect.promise(() =>
        Promise.allSettled([fixture.open(), fixture.open()]),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const failures = results.filter((result) => result.status === 'rejected')
      expect(failures).toHaveLength(1)
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(StorageOwned)
        expect(failure.reason).toMatchObject(new StorageOwned({ schema: fixture.schema }))
      }
      expect(
        (yield* Effect.promise(() =>
          fixture.pool.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [
            fixture.schema,
          ]),
        )).rows,
      ).toEqual([{ count: 9 }])
    }),
  )
})
