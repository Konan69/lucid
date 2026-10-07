import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { StorageOwned } from './errors.ts'
import { openPgDatabase } from './pg.ts'
import { PostgresStorage } from './storage.ts'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
const context = BACKGROUND_CONTEXT

describe.skipIf(Option.isNone(testUrl))('PostgreSQL single ownership', () => {
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
