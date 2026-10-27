import * as NodeBuffer from 'node:buffer'
import { Option, Result, Schema } from 'effect'
import { types, type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import type { Database, Executor, Prepared, SqlValue, Statement } from './database.ts'
import { OwnershipLost, RawNul, ResultInvalid } from './errors.ts'
import { quoteLiteral } from './literal.ts'

/**
 * The authority this process took (`stores.ts`): the owner row's generation, as BIGINT text, and
 * the process identity written beside it.
 */
export interface Authority {
  readonly generation: string
  readonly process: string
}

/**
 * The fence: the first statement of every write transaction. `FOR SHARE` lets every writer of
 * this process hold it at once (no write ever updates this row, so commits never queue on it)
 * and makes a takeover's UPDATE of the row wait until each of them has committed.
 */
export const FENCE =
  'SELECT generation::text AS generation, process FROM runtime.owner WHERE id = 1 FOR SHARE'

/**
 * PostgreSQL's answer to a simple-protocol batch is one result per statement (pg
 * `lib/query.js`, `_checkForMultirow`). Decoded once here, before anything reads a row.
 */
const QueryEnvelope = Schema.Struct({
  rows: Schema.Array(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
    ),
  ),
})
const decodeBatch = Schema.decodeUnknownResult(Schema.Array(QueryEnvelope))
const decodeFence = Schema.decodeUnknownResult(
  Schema.Struct({ generation: Schema.String, process: Schema.String }),
)

/** The rows of each statement of a batch, in order; anything else is `ResultInvalid`. */
function batchRows(result: QueryResult | QueryResult[]) {
  const decoded = decodeBatch(result)
  if (Result.isFailure(decoded)) throw new ResultInvalid()
  return decoded.success.map((item) => item.rows)
}

/**
 * Refuse unless the owner row names this process's generation. The row is locked `FOR SHARE`
 * by now and stays locked until this transaction ends, so the answer holds through COMMIT.
 */
function checkFence(authority: Authority, rows: Option.Option<readonly object[]>) {
  const row = Option.flatMap(rows, (set) => Option.fromNullishOr(set[0]))
  if (Option.isNone(row)) throw new OwnershipLost({ held: authority.generation, current: 'none' })
  const fence = decodeFence(row.value)
  if (Result.isFailure(fence)) throw new ResultInvalid()
  if (
    fence.success.generation !== authority.generation ||
    fence.success.process !== authority.process
  )
    throw new OwnershipLost({ held: authority.generation, current: fence.success.generation })
}

const isBytes = Schema.is(Schema.Uint8Array)

/**
 * Bind one statement as literal text. PostgreSQL's extended protocol takes one statement per
 * message, so a batch (BEGIN, the fence and the reads; or the writes and COMMIT) is sent as
 * simple-protocol text, which removes round trips and changes nothing about order or
 * durability. Each value is quoted as pg's `escapeLiteral` would (`literal.ts`); bytes go as hex.
 */
function statementText(statement: Statement): string {
  let index = 0
  return statement.sql.replace(/\?/gu, () => {
    const value = statement.params[index++]
    if (value === undefined) throw new Error('PostgreSQL batch binding is missing')
    if (value === null) return 'NULL'
    if (isBytes(value))
      return `decode(${quoteLiteral(NodeBuffer.Buffer.from(value).toString('hex'))}, 'hex')`
    const text = String(value)
    if (text.includes('\u0000')) throw new RawNul({ recordKind: statement.recordKind })
    return quoteLiteral(text)
  })
}

const int8Text = (value: string) => value

/**
 * BIGINT stays decimal text for this storage's queries, whatever parser the process installed
 * globally (pg `lib/defaults.js`, `parseInt8`), in text and binary mode alike; the storage checks
 * it before turning it into a number. No global parser is changed.
 */
const bigintAsText = {
  // SAFETY: pg declares `getTypeParser` as overloads keyed by format; this one function answers
  // both, delegating every type but INT8 to pg's own parser for the same format.
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid !== types.builtins.INT8) return types.getTypeParser(oid, format)
    if (format === 'binary') return (value: NodeBuffer.Buffer) => value.readBigInt64BE().toString()
    return int8Text
  }) as typeof types.getTypeParser,
}

/** `?` placeholders as PostgreSQL's `$n`, in order. The SQL is this storage's own. */
const numbered = (sql: string) => {
  let index = 0
  return sql.replace(/\?/gu, () => `$${++index}`)
}

/**
 * A pooled connection checked out by a transaction. pg emits `error` on a connection that dies
 * while a query is active (`lib/client.js`, `_handleErrorEvent`), and pg-pool listens only while
 * the connection is idle; without this listener such a death would end the process. The failure
 * itself reaches the transaction through the rejected query.
 */
const ignoreError = (_cause: Error) => {}

/**
 * One transaction's statements on the connection it holds. A settled transaction refuses more.
 */
function transactionExecutor(client: PoolClient, active: () => boolean): Executor {
  const query = <T extends QueryResultRow>(sql: string, params: SqlValue[]) => {
    if (!active()) return Promise.reject(new Error('PostgreSQL transaction is no longer active'))
    return client.query<T>({ text: numbered(sql), values: params, types: bigintAsText })
  }
  return {
    runBatch: (statements) => {
      if (!active()) return Promise.reject(new Error('PostgreSQL transaction is no longer active'))
      return client.query(statements.map(statementText).join(';\n')).then(() => {})
    },
    get: <T extends object>(sql: string, ...params: SqlValue[]) =>
      query<T & QueryResultRow>(sql, params).then((result) => Option.fromNullishOr(result.rows[0])),
    all: <T extends object>(sql: string, ...params: SqlValue[]) =>
      query<T & QueryResultRow>(sql, params).then((result): T[] => result.rows),
  }
}

/**
 * Roll back and give the connection back. A rollback that fails means the connection is not
 * fit to reuse, so it is destroyed, and the failure is not reported as a clean rollback.
 */
function rollback(client: PoolClient, cause: unknown): Promise<never> {
  return client.query('ROLLBACK').then(
    () => {
      client.removeListener('error', ignoreError)
      client.release()
      throw cause
    },
    (rollbackCause: Error) => {
      client.removeListener('error', ignoreError)
      client.release(rollbackCause)
      throw new AggregateError(
        [cause, rollbackCause],
        'PostgreSQL transaction failed and rollback failed',
      )
    },
  )
}

/** SQLSTATEs that prove the statement or the whole transaction was rolled back. */
const isTransient = Schema.is(Schema.Struct({ code: Schema.Literals(['40001', '40P01', '55P03']) }))

/**
 * Retry a read, or a whole transaction that PostgreSQL rolled back as a serialization failure, a
 * deadlock or a lock that was not available, at most twice and at once. A lost connection and an
 * uncertain COMMIT reach Pi unchanged, and so does `OwnershipLost`. Carried over from the
 * earlier port: a takeover that commits while a write waits for the fence makes PostgreSQL
 * answer 40001, and the retry then reads the new generation and refuses.
 */
function retried<A>(work: () => Promise<A>, remaining = 2): Promise<A> {
  return work().catch((cause: unknown) => {
    if (remaining === 0 || !isTransient(cause)) throw cause
    return retried(work, remaining - 1)
  })
}

/**
 * The database every store of this process shares: one pool, connections borrowed per read or
 * per transaction (the shape of Mastra's PostgreSQL transaction lease), nothing held between
 * calls, and no session setting changed on a pooled connection.
 *
 * Adapted from the earlier one-schema-per-store port (`PgDatabase`), which leased one connection
 * for a store's whole life, set its `search_path` and held a per-schema advisory lock on it.
 * Ownership is now the process's (`stores.ts`), checked inside each write by `FENCE`.
 */
export class PooledDatabase implements Database {
  private readonly pool: Pool
  private readonly authority: Authority

  constructor(pool: Pool, authority: Authority) {
    this.pool = pool
    this.authority = authority
  }

  get<T extends object>(sql: string, ...params: SqlValue[]): Promise<Option.Option<T>> {
    return retried(() =>
      this.pool
        .query<T & QueryResultRow>({ text: numbered(sql), values: params, types: bigintAsText })
        .then((result) => Option.fromNullishOr(result.rows[0])),
    )
  }

  all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return retried(() =>
      this.pool
        .query<T & QueryResultRow>({ text: numbered(sql), values: params, types: bigintAsText })
        .then((result): T[] => result.rows),
    )
  }

  write<T>(
    reads: readonly Statement[],
    callback: (transaction: Executor, rows: readonly (readonly object[])[]) => Promise<Prepared<T>>,
  ): Promise<T> {
    return retried(() =>
      this.pool.connect().then((client) => this.attempt(client, reads, callback)),
    )
  }

  /**
   * One attempt: BEGIN, the fence and the reads in one round trip; the callback, which may read
   * on the transaction and returns the last writes; those writes and COMMIT in one round trip.
   * A failure anywhere, the fence's refusal included, rolls back before it is reported.
   */
  private attempt<T>(
    client: PoolClient,
    reads: readonly Statement[],
    callback: (transaction: Executor, rows: readonly (readonly object[])[]) => Promise<Prepared<T>>,
  ): Promise<T> {
    client.on('error', ignoreError)
    const state = { active: true }
    const transaction = transactionExecutor(client, () => state.active)
    return Promise.resolve()
      .then(() =>
        // The preflight rows are decoded like any other read: BIGINT as text, whatever parser
        // the pool's connections were given.
        client.query({
          text: ['BEGIN ISOLATION LEVEL REPEATABLE READ', FENCE, ...reads.map(statementText)].join(
            ';\n',
          ),
          types: bigintAsText,
        }),
      )
      .then((result) => {
        const sets = batchRows(result)
        checkFence(this.authority, Option.fromNullishOr(sets[1]))
        return callback(transaction, sets.slice(2))
      })
      .then((prepared) => {
        state.active = false
        return client
          .query([...prepared.statements.map(statementText), 'COMMIT'].join(';\n'))
          .then(() => prepared.value)
      })
      .then(
        (value) => {
          client.removeListener('error', ignoreError)
          client.release()
          return value
        },
        (cause: unknown) => {
          state.active = false
          return rollback(client, cause)
        },
      )
  }
}
