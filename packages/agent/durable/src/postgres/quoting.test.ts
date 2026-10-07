import { Effect } from 'effect'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type {
  ConversationId,
  EntryId,
  TaskId,
  SubmissionId,
  DocumentId,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import * as Option from 'effect/Option'
import { Pool } from 'pg'
import { describe, expect, it } from '@effect/vitest'
import { onTestFinished } from 'vitest'
import { ConnectionSettingInvalid, RawNul } from './errors.ts'
import { openPgDatabase, openPgStorage } from './pg.ts'
import { PostgresStorage } from './storage.ts'
import { postgresFixture, rejected } from './testing.ts'
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
const context = BACKGROUND_CONTEXT
/** Review10c adversarial strings, including both SJIS lead-byte probes. These
 * remain data on UTF8; JSON escaping preserves NUL and lone UTF16 surrogates. */
const adversarial = [
  "x'); DROP TABLE entries; --",
  "a\\'; DROP TABLE entries; --",
  'ends with backslash \\',
  '$$ $1 $tag$ ? ?? ;',
  'nul\u0000inside',
  'lone\ud800surrogate',
  '\n\r\t\b\f\u001f\u007f\u2028',
  '😀 é 漢',
  "\u0081\\'; DROP TABLE entries; --",
  "\u0081\\'); CREATE TABLE pwned (x int); --",
  "A'\\".repeat(1000000),
]
describe.skipIf(Option.isNone(testUrl))('PostgreSQL literal safety', () => {
  /** Reject before namespace creation, with both SJIS settings from the review.
   * Options are public Pool startup parameters; no driver mocks or mutation. */
  it.live.each(['', ' -c backslash_quote=on'])('refuses SJIS at open (%s)', (extra) =>
    Effect.gen(function* () {
      const pool = new Pool({
        connectionString: Option.getOrThrow(testUrl),
        max: 1,
      })
      onTestFinished(() => pool.end())
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      // pg/lib/client.js:getStartupConf forces UTF8 after startup options. Set the
      // reviewer's mode explicitly on the real lease, then return it for opening.
      const client = yield* Effect.promise(() => pool.connect())
      yield* Effect.promise(() =>
        client.query(`SET client_encoding=SJIS${extra === '' ? '' : '; SET backslash_quote=on'}`),
      )
      expect((yield* Effect.promise(() => client.query('SHOW client_encoding'))).rows).toEqual([
        { client_encoding: 'SJIS' },
      ])
      client.release()
      const result = openPgStorage(pool, fixture.schema).then((storage) => {
        fixture.track(storage)
        return storage
      })
      expect((yield* rejected(() => result)).cause).toBeInstanceOf(ConnectionSettingInvalid)
      expect((yield* rejected(() => result)).cause).toMatchObject(
        new ConnectionSettingInvalid({ setting: 'client_encoding', value: 'SJIS' }),
      )
      expect(
        (yield* Effect.promise(() =>
          fixture.pool.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [fixture.schema]),
        )).rows,
      ).toEqual([])
      // Refusal discards only the unsafe lease; the host Pool remains usable.
      expect((yield* Effect.promise(() => pool.query('SELECT 1 AS usable'))).rows).toEqual([
        { usable: 1 },
      ])
    }),
  )
  /** pg.escapeLiteral produces E literals for backslashes, valid with either
   * standard_conforming_strings mode. All review payloads survive exact JSON
   * round trips, including extension keys; indexed text follows the same rule. */
  it.live.each(['on', 'off'])(
    'round-trips adversarial text with standard_conforming_strings=%s',
    (mode) =>
      Effect.gen(function* () {
        const pool = new Pool({
          connectionString: Option.getOrThrow(testUrl),
          max: 1,
          options: `-c client_encoding=UTF8 -c standard_conforming_strings=${mode}`,
        })
        onTestFinished(() => pool.end())
        const fixture = postgresFixture(Option.getOrThrow(testUrl))
        const storage = yield* Effect.promise(() => openPgStorage(pool, fixture.schema))
        fixture.track(storage)
        const conversationId = yield* Effect.promise(() => storage.mintId<ConversationId>())
        yield* Effect.promise(() =>
          storage.commit([{ type: 'conversation', value: { id: conversationId } }], context),
        )
        for (const text of adversarial) {
          const id = yield* Effect.promise(() => storage.mintId<EntryId>())
          const value = { id, conversationId, kind: 'probe', payload: text, [text.slice(0, 40)]: 1 }
          yield* Effect.promise(() => storage.commit([{ type: 'entry', value }], context))
          const back = yield* Effect.promise(() => storage.entry(id, context))
          expect(JSON.stringify(Option.getOrThrow(Option.fromNullishOr(back)).entry)).toBe(
            JSON.stringify(value),
          )
        }
        yield* verifyIndexedText(storage, conversationId)
        expect(
          (yield* Effect.promise(() =>
            fixture.pool.query('SELECT to_regclass($1) AS name', [`${fixture.schema}.pwned`]),
          )).rows,
        ).toEqual([{ name: null }])
        expect(
          (yield* Effect.promise(() =>
            fixture.pool.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [
              fixture.schema,
            ]),
          )).rows,
        ).toEqual([{ count: 9 }])
        yield* Effect.promise(() => storage.close(context))
        expect(
          (yield* Effect.promise(() => pool.query('SHOW standard_conforming_strings'))).rows,
        ).toEqual([{ standard_conforming_strings: mode }])
      }),
  )
  /** Raw NUL cannot be represented in PostgreSQL SQL text. The facade validates
   * the entire final segment before sending it, then rolls back: earlier planned
   * metadata writes cannot consume a sequence. JSON-escaped NUL is tested above. */
  it.live('rejects raw NUL with record context and leaves allocation unchanged', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const db = yield* Effect.promise(() => openPgDatabase(fixture.pool, fixture.schema))
      const storage = yield* Effect.promise(() => PostgresStorage.open(db, fixture.schema))
      fixture.track(storage)
      const id = yield* Effect.promise(() => storage.mintId<ConversationId>())
      const before = yield* Effect.promise(() =>
        storage.commit([{ type: 'conversation', value: { id } }], context),
      )
      const result = db.transactionWithReads([], () =>
        Promise.resolve({
          value: 0,
          statements: [
            {
              recordKind: 'metadata' as const,
              sql: 'UPDATE durable_metadata SET next_seq = next_seq + 1',
              params: [],
            },
            { recordKind: 'entry' as const, sql: 'SELECT ?::text', params: ['raw\u0000NUL'] },
          ],
        }),
      )
      expect((yield* rejected(() => result)).cause).toBeInstanceOf(RawNul)
      expect((yield* rejected(() => result)).cause).toMatchObject(
        new RawNul({ recordKind: 'entry' }),
      )
      const entryId = yield* Effect.promise(() => storage.mintId<EntryId>())
      expect(
        yield* Effect.promise(() =>
          storage.commit(
            [{ type: 'entry', value: { id: entryId, conversationId: id, kind: 'after' } }],
            context,
          ),
        ),
      ).toBe(before + 1)
    }),
  )
})
/** The review also exercised extracted task kind, request id, document kind/key
 * and revision value. Check them through Storage queries rather than SQL internals. */
function verifyIndexedText(storage: PostgresStorage, conversationId: ConversationId) {
  return Effect.gen(function* () {
    const kind = "k'\\\u0000\ud800"
    const requestId = "r'; DROP TABLE tasks; --\\"
    const taskId = yield* Effect.promise(() => storage.mintId<TaskId<JsonValue>>())
    const submissionId = yield* Effect.promise(() => storage.mintId<SubmissionId>())
    const documentId = yield* Effect.promise(() => storage.mintId<DocumentId>())
    const record = {
      id: documentId,
      kind,
      key: requestId,
      scope: { kind: 'conversation' as const, conversationId },
      history: 'rewindable' as const,
      fork: 'asOf' as const,
    }
    const value = { text: "nul\u0000insidea\\'; DROP TABLE entries; --lone\ud800surrogate" }
    yield* Effect.promise(() =>
      storage.commit(
        [
          {
            type: 'task',
            value: {
              id: taskId,
              conversationId,
              kind,
              version: 1,
              input: {},
              background: false,
              abortRequested: false,
              state: { status: 'pending', checkpoint: {} },
            },
          },
          {
            type: 'submission',
            value: { id: submissionId, conversationId, requestId, type: 'write', status: 'queued' },
          },
          { type: 'document.create', record, content: { kind: 'base', version: 1, value } },
        ],
        context,
      ),
    )
    expect(
      (yield* Effect.promise(() => storage.scanTasks({ kind }, 10, undefined, context))).items,
    ).toMatchObject([{ id: taskId, kind }])
    expect(
      yield* Effect.promise(() => storage.submissionByRequest(conversationId, requestId, context)),
    ).toMatchObject({
      id: submissionId,
      requestId,
    })
    expect(
      yield* Effect.promise(() => storage.findDocument(record, 'current', context)),
    ).toMatchObject(record)
    expect(
      yield* Effect.promise(() => storage.document(documentId, 'current', context)),
    ).toMatchObject({ record, value })
  })
}
