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
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { onTestFinished } from 'vitest'
import { StorageOwned, StorageDisconnected } from './main.ts'
import { openPgDatabase, openPgStorage } from './pg.ts'
import { PostgresStorage } from './storage.ts'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
const context = BACKGROUND_CONTEXT

describe.skipIf(Option.isNone(testUrl))('PostgreSQL single ownership', () => {
  /** Review11c C: a max=1 Pool is exhausted by a storage's lifetime lease.
   * The host's connectionTimeoutMillis bounds that wait; the adapter neither
   * changes the pool's capacity nor borrows another backend behind its owner. */
  it('honors the host connection timeout on an exhausted pool', async () => {
    const pool = new Pool({
      connectionString: Option.getOrThrow(testUrl),
      max: 1,
      connectionTimeoutMillis: 1000,
    })
    onTestFinished(() => pool.end())
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const storage = await openPgStorage(pool, fixture.schema)
    fixture.track(storage)
    await expect(openPgStorage(pool, fixture.schema)).rejects.toThrow(
      'timeout exceeded when trying to connect',
    )
    await storage.close(context)
    expect((await pool.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }])
  })
  /** Review11c A: the backend owns both the session lock and all commits. Losing
   * it must fence even mintId, retain the original cause, and require reopen. */
  it('fences every storage operation with one typed disconnection', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const db = await openPgDatabase(fixture.pool, fixture.schema)
    const storage = await PostgresStorage.open(db, fixture.schema)
    fixture.track(storage)
    const pid = Option.getOrThrow(
      await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
    ).pid
    const entryId = await storage.mintId<EntryId>()
    const taskId = await storage.mintId<TaskId<JsonValue>>()
    const submissionId = await storage.mintId<SubmissionId>()
    const documentId = await storage.mintId<DocumentId>()
    await fixture.pool.query('SELECT pg_terminate_backend($1, 1000)', [pid])
    const disconnected = await storage.mintId().catch((cause: unknown) => cause)
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
        storage.findDocument({ kind: 'document', scope: { kind: 'session' } }, 'current', context),
      () => storage.document(documentId, 'current', context),
      () => storage.scanTasks({}, 1, undefined, context),
      () => storage.scanSubmissions({}, 1, undefined, context),
    ]
    for (const call of calls) await expect(call()).rejects.toBe(disconnected)
    await storage.close(context)
    const reopened = await fixture.open()
    expect(await reopened.commit([], context)).toBe(1)
  })
  /** A second lease cannot run migrations or mint against an active owner's
   * schema. close must unlock even though the pooled backend remains alive. */
  it('refuses a second owner and admits it after the first closes', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const first = await fixture.open()
    const failure = fixture.open()
    await expect(failure).rejects.toBeInstanceOf(StorageOwned)
    await expect(failure).rejects.toMatchObject(new StorageOwned({ schema: fixture.schema }))
    await first.close(context)
    const next = await fixture.open()
    expect(await next.commit([], context)).toBe(1)
  })

  /** pg_terminate_backend(pid, milliseconds) waits for the targeted backend's
   * death on PostgreSQL 18. This is a database completion signal, not polling.
   * The original facade remains open: PostgreSQL itself must release its lock. */
  it('admits a new owner after the owning backend dies', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const db = await openPgDatabase(fixture.pool, fixture.schema)
    const first = await PostgresStorage.open(db, fixture.schema)
    fixture.track(first)
    const pid = Option.getOrThrow(
      await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
    ).pid
    expect(
      (await fixture.pool.query('SELECT pg_terminate_backend($1, 1000) AS stopped', [pid])).rows,
    ).toEqual([{ stopped: true }])
    const next = await fixture.open()
    expect(await next.commit([], context)).toBe(1)
    await expect(db.exec('SELECT 1')).rejects.toThrow()
    await first.close(context)
  })

  /** Distinct schema names have distinct stable advisory keys within the same
   * database; acquiring one must leave the other independently usable. */
  it('allows simultaneous owners of different schemas', async () => {
    const one = postgresFixture(Option.getOrThrow(testUrl))
    const two = postgresFixture(Option.getOrThrow(testUrl))
    const left = await one.open()
    const right = await two.open()
    expect(await left.commit([], context)).toBe(1)
    expect(await right.commit([], context)).toBe(1)
  })

  /** Race two real leases before a schema exists. The nonblocking ownership
   * guard must produce exactly one winner and one StorageOwned, before the
   * losing lease can reach CREATE SCHEMA and produce a raw pg_namespace 23505. */
  it('guards concurrent first opens before migrations', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const results = await Promise.allSettled([fixture.open(), fixture.open()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failures = results.filter((result) => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    for (const failure of failures) {
      expect(failure.reason).toBeInstanceOf(StorageOwned)
      expect(failure.reason).toMatchObject(new StorageOwned({ schema: fixture.schema }))
    }
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1',
          [fixture.schema],
        )
      ).rows,
    ).toEqual([{ count: 9 }])
  })
})
