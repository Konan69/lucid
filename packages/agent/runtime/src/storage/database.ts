import type { Option } from 'effect'
import type { RecordKind } from './errors.ts'

/**
 * A value bound into a statement. Pi's SQLite storage binds the same vocabulary
 * (`SqliteValue`).
 */
export type SqlValue = null | number | bigint | string | Uint8Array

/** The record a statement writes, kept so a refused value names where it came from. */
export type RecordKindName = typeof RecordKind.Type

/**
 * One statement this storage wrote, with its bindings: SQL text is never built from a caller's
 * data. Statements keep `?` placeholders; the driver binds them.
 */
export type Statement = {
  readonly recordKind: RecordKindName
  readonly sql: string
  readonly params: readonly SqlValue[]
}

/**
 * What a write transaction's callback hands back: the value to return once COMMIT has succeeded,
 * and the last ordered writes, which the driver sends together with COMMIT.
 */
export type Prepared<T> = {
  readonly value: T
  readonly statements: readonly Statement[]
}

/**
 * The statements a write transaction runs on the connection it holds. BIGINT columns arrive as
 * decimal text, so no identity passes through a lossy JavaScript number before `safeNumber`.
 * `get` answers absence as `Option`, where Pi's facade answers `undefined`.
 */
export interface Executor {
  /** One ordered batch; the first failing statement stops it. */
  runBatch(statements: readonly Statement[]): Promise<void>
  get<T extends object>(sql: string, ...params: SqlValue[]): Promise<Option.Option<T>>
  all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]>
}

/**
 * The one database every store shares. A read borrows a pooled connection for one statement; a
 * write borrows one for the whole transaction. Neither holds a connection between calls, and
 * closing a store never closes this.
 *
 * `write` is the only way to change a row. It opens a REPEATABLE READ transaction, reads the
 * owner row `FOR SHARE` before anything else, and refuses with `OwnershipLost` (writing nothing)
 * when the generation is not the one this process took. The share lock is held until COMMIT, so
 * a takeover waits for the transaction and every later transaction sees the new generation.
 * The `reads` run in the same round trip as BEGIN and the fence; the callback receives their rows
 * in order. Only a successful COMMIT resolves the returned value; any failure rolls back first.
 */
export interface Database extends Pick<Executor, 'get' | 'all'> {
  write<T>(
    reads: readonly Statement[],
    callback: (transaction: Executor, rows: readonly (readonly object[])[]) => Promise<Prepared<T>>,
  ): Promise<T>
}

/**
 * A BIGINT column's text as a JavaScript number, refusing one outside the safe range rather than
 * rounding it. Pi's identities and sequences are numbers (`src/ids.ts`).
 */
export function safeNumber(value: string): number {
  const integer = BigInt(value)
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError("Conversation store integer exceeds JavaScript's safe range")
  return Number(integer)
}
