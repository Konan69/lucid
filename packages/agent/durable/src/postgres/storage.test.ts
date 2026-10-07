import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, DocumentId, EntryId } from '@earendil-works/pi-durable'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'

import { postgresFixture } from './testing.ts'

const context = BACKGROUND_CONTEXT
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])

/** Pi src/testing/storage-conformance.ts:createStorageConformance and runner.ts:
 * registerStorageConformance, unmodified upstream cases through the real pg driver. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL', () => {
  registerStorageConformance({ describe, expect, it }, 'Pi PostgreSQL storage', async (use) => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    await use(await fixture.open())
  })

  /** Driver failure after a table insert must roll back the row AND sequence
   * allocation. Unlike a preflight rejection this exercises the database rollback. */
  it('a SQL constraint failure leaves no row and consumes no commit sequence', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const storage = await fixture.open()
    const root = await storage.mintId<ConversationId>()
    const first = await storage.commit([{ type: 'conversation', value: { id: root } }], context)
    await fixture.pool.query(
      `ALTER TABLE "${fixture.schema}".entries ADD CONSTRAINT reject_insert CHECK (id < 0) NOT VALID`,
    )
    const id = await storage.mintId<EntryId>()
    await expect(
      storage.commit(
        [{ type: 'entry', value: { id, conversationId: root, kind: 'failure' } }],
        context,
      ),
    ).rejects.toThrow('reject_insert')
    expect(await storage.entry(id, context)).toBeUndefined()
    await fixture.pool.query(
      `ALTER TABLE "${fixture.schema}".entries DROP CONSTRAINT reject_insert`,
    )
    expect(
      await storage.commit(
        [{ type: 'entry', value: { id, conversationId: root, kind: 'success' } }],
        context,
      ),
    ).toBe(first + 1)
  })

  /** Pi types.ts:DocumentContent.version and SQLite migrations.ts:document_revisions
   * use the same 64-bit integer range as ids. PostgreSQL INTEGER would narrow it. */
  it('retains document versions above the PostgreSQL INTEGER range', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const storage = await fixture.open()
    const id = await storage.mintId<DocumentId>()
    const version = 2 ** 32
    await storage.commit(
      [
        {
          type: 'document.create',
          record: { id, kind: 'versioned', scope: { kind: 'session' } },
          content: { kind: 'base', version, value: { count: 0 } },
        },
      ],
      context,
    )
    await storage.commit(
      [
        {
          type: 'document.change',
          id,
          content: { kind: 'delta', version, ops: [['s', ['count'], 1]] },
        },
      ],
      context,
    )
    await storage.close(context)
    const reopened = await fixture.open()
    expect(await reopened.document(id, 'current', context)).toMatchObject({
      version,
      value: { count: 1 },
    })
  })

  /** Pi mintId exhausts at MAX_SAFE_INTEGER. BIGINT metadata keeps its next-id
   * sentinel lossless across reopen, even when the host configures a lossy parser. */
  it('preserves the safe-integer edge and refuses exhausted allocation after reopen', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const before = await fixture.open()
    await before.close(context)
    await fixture.pool.query(`UPDATE "${fixture.schema}".durable_metadata SET next_id = $1`, [
      String(Number.MAX_SAFE_INTEGER),
    ])
    const storage = await fixture.open()
    const last = await storage.mintId<ConversationId>()
    expect(last).toBe(Number.MAX_SAFE_INTEGER)
    await storage.commit([{ type: 'conversation', value: { id: last } }], context)
    await expect(storage.mintId()).rejects.toThrow('ID space is exhausted')
    await storage.close(context)
    const reopened = await fixture.open()
    expect(await reopened.conversation(last, context)).toEqual({ id: last })
    await expect(reopened.mintId()).rejects.toThrow('ID space is exhausted')
    const result = await fixture.pool.query<{ next_id: string }>(
      `SELECT next_id::text FROM "${fixture.schema}".durable_metadata`,
    )
    expect(result.rows[0]).toEqual({ next_id: '9007199254740992' })
  })
})
