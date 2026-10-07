import { it as upstreamIt } from 'vitest'
import { Effect } from 'effect'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, DocumentId, EntryId } from '@earendil-works/pi-durable'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import * as Option from 'effect/Option'
import { describe, expect, it } from '@effect/vitest'
import { postgresFixture, rejected } from './testing.ts'
const context = BACKGROUND_CONTEXT
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
/** Pi src/testing/storage-conformance.ts:createStorageConformance and runner.ts:
 * registerStorageConformance, unmodified upstream cases through the real pg driver. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL', () => {
  // Pi runner.ts registers its own Promise cases; it is not an Effect test API.
  // Our fixture callback is a plain Promise adapter, so asyncFunction reports no local line.
  registerStorageConformance(
    { describe, expect, it: upstreamIt },
    'Pi PostgreSQL storage',
    (use) => {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      return fixture.open().then((storage) => use(storage))
    },
  )
  /** Driver failure after a table insert must roll back the row AND sequence
   * allocation. Unlike a preflight rejection this exercises the database rollback. */
  it.live('a SQL constraint failure leaves no row and consumes no commit sequence', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const storage = yield* Effect.promise(() => fixture.open())
      const root = yield* Effect.promise(() => storage.mintId<ConversationId>())
      const first = yield* Effect.promise(() =>
        storage.commit([{ type: 'conversation', value: { id: root } }], context),
      )
      yield* Effect.promise(() =>
        fixture.pool.query(
          `ALTER TABLE "${fixture.schema}".entries ADD CONSTRAINT reject_insert CHECK (id < 0) NOT VALID`,
        ),
      )
      const id = yield* Effect.promise(() => storage.mintId<EntryId>())
      expect(
        (yield* rejected(() =>
          storage.commit(
            [{ type: 'entry', value: { id, conversationId: root, kind: 'failure' } }],
            context,
          ),
        )).raise,
      ).toThrow('reject_insert')
      expect(yield* Effect.promise(() => storage.entry(id, context))).toBeUndefined()
      yield* Effect.promise(() =>
        fixture.pool.query(`ALTER TABLE "${fixture.schema}".entries DROP CONSTRAINT reject_insert`),
      )
      expect(
        yield* Effect.promise(() =>
          storage.commit(
            [{ type: 'entry', value: { id, conversationId: root, kind: 'success' } }],
            context,
          ),
        ),
      ).toBe(first + 1)
    }),
  )
  /** Pi types.ts:DocumentContent.version and SQLite migrations.ts:document_revisions
   * use the same 64-bit integer range as ids. PostgreSQL INTEGER would narrow it. */
  it.live('retains document versions above the PostgreSQL INTEGER range', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const storage = yield* Effect.promise(() => fixture.open())
      const id = yield* Effect.promise(() => storage.mintId<DocumentId>())
      const version = 2 ** 32
      yield* Effect.promise(() =>
        storage.commit(
          [
            {
              type: 'document.create',
              record: { id, kind: 'versioned', scope: { kind: 'session' } },
              content: { kind: 'base', version, value: { count: 0 } },
            },
          ],
          context,
        ),
      )
      yield* Effect.promise(() =>
        storage.commit(
          [
            {
              type: 'document.change',
              id,
              content: { kind: 'delta', version, ops: [['s', ['count'], 1]] },
            },
          ],
          context,
        ),
      )
      yield* Effect.promise(() => storage.close(context))
      const reopened = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => reopened.document(id, 'current', context))).toMatchObject({
        version,
        value: { count: 1 },
      })
    }),
  )
  /** Pi mintId exhausts at MAX_SAFE_INTEGER. BIGINT metadata keeps its next-id
   * sentinel lossless across reopen, even when the host configures a lossy parser. */
  it.live('preserves the safe-integer edge and refuses exhausted allocation after reopen', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const before = yield* Effect.promise(() => fixture.open())
      yield* Effect.promise(() => before.close(context))
      yield* Effect.promise(() =>
        fixture.pool.query(`UPDATE "${fixture.schema}".durable_metadata SET next_id = $1`, [
          String(Number.MAX_SAFE_INTEGER),
        ]),
      )
      const storage = yield* Effect.promise(() => fixture.open())
      const last = yield* Effect.promise(() => storage.mintId<ConversationId>())
      expect(last).toBe(Number.MAX_SAFE_INTEGER)
      yield* Effect.promise(() =>
        storage.commit([{ type: 'conversation', value: { id: last } }], context),
      )
      expect((yield* rejected(() => storage.mintId())).raise).toThrow('ID space is exhausted')
      yield* Effect.promise(() => storage.close(context))
      const reopened = yield* Effect.promise(() => fixture.open())
      expect(yield* Effect.promise(() => reopened.conversation(last, context))).toEqual({
        id: last,
      })
      expect((yield* rejected(() => reopened.mintId())).raise).toThrow('ID space is exhausted')
      const result = yield* Effect.promise(() =>
        fixture.pool.query<{
          next_id: string
        }>(`SELECT next_id::text FROM "${fixture.schema}".durable_metadata`),
      )
      expect(result.rows[0]).toEqual({ next_id: '9007199254740992' })
    }),
  )
})
