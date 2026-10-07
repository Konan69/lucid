import type * as Option from 'effect/Option'
import type { RecordKind } from './errors.ts'

/**
 * Port of Pi Durable `src/storage/sqlite/database.ts:SqliteValue`.
 * PostgreSQL bindings retain the reference's scalar and byte-array vocabulary.
 */
export type PostgresValue = null | number | bigint | string | Uint8Array

/** Owned SQL plus bindings, never caller-supplied SQL interpolation. Ordered
 * batches retain Pi SqliteStorage's individual statements, including duplicate
 * mutable-id upserts; multi-row INSERT would change their order and errors. */
export type PostgresStatement = {
  readonly recordKind: PostgresRecordKind
  readonly sql: string
  readonly params: readonly PostgresValue[]
}

/** Pi src/types.ts:StorageWrite supplies the record vocabulary. Document actions
 * share one record kind; metadata allocation has no user record. Retain this
 * context in SQL plans so a rejected raw NUL identifies its originating record. */
export type PostgresRecordKind = typeof RecordKind.Type

/** Pi SqliteStorage.commit's result and final ordered write segment. The driver
 * executes this segment followed by COMMIT before returning the value. A prepared
 * plan is not a write acknowledgment; a failed statement still rolls back. */
export type PostgresCommit<T> = {
  readonly value: T
  readonly statements: readonly PostgresStatement[]
}

/**
 * Port of Pi Durable `src/storage/sqlite/database.ts:SqliteExecutor`.
 *
 * `exec` runs unbound SQL and may contain several statements. `run`, `get`, and
 * `all` execute one statement with positional bindings. The facade keeps SQLite's `?` positional placeholders; the pg adapter maps
 * these to PostgreSQL's `$1` syntax. SQL text is owned by this port.
 * Drivers return BIGINT columns as decimal strings, preserving their full range
 * until storage checks and converts values required by Pi's numeric interface.
 * Unlike Pi's `T | undefined`, `get` returns Option to satisfy the repository's
 * explicit-absence rule. Storage converts with Option.getOrUndefined at Pi's boundary.
 */
export interface PostgresExecutor {
  /** One ordered simple-protocol batch; the first failing statement stops the batch. */
  runBatch(statements: readonly PostgresStatement[]): Promise<void>
  exec(sql: string): Promise<void>
  run(sql: string, ...params: PostgresValue[]): Promise<void>
  get<T extends object>(sql: string, ...params: PostgresValue[]): Promise<Option.Option<T>>
  all<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T[]>
}

/**
 * Port of Pi Durable `src/storage/sqlite/database.ts:SqliteDatabase`.
 *
 * All transaction work must use the supplied handle, which becomes invalid once
 * the callback settles. Unrelated operations and transactions queue until commit
 * or rollback finishes. Calling the database itself (including `transaction` or
 * `close`) from the callback waits for that transaction and never settles.
 *
 * A rejecting callback is rolled back before its original error is returned. A
 * rollback failure rejects with a different error, such as an AggregateError,
 * so the caller cannot mistake it for a guaranteed rollback.
 */
export interface PostgresDatabase extends PostgresExecutor {
  /** Cached driver health, without SQL: losing a lease fences volatile mintId
   * as well as persistence. This PostgreSQL addition never reconnects. */
  assertConnected(): void
  /** Pi transaction's same barrier/rollback rules, with BEGIN and independent
   * preflight reads sent together in their original order. Read results are
   * decoded by storage before any write; no allocation happens outside the transaction.
   * This owned-facade extension avoids changing the host Pool's pipeline setting.
   * The callback returns a prepared final segment, which is sent with COMMIT as
   * one query. Only successful COMMIT acknowledges its value; any native failure
   * skips following statements and triggers the reference rollback handling. */
  transactionWithReads<T>(
    reads: readonly PostgresStatement[],
    callback: (
      transaction: PostgresExecutor,
      rows: readonly (readonly object[])[],
    ) => Promise<PostgresCommit<T>>,
  ): Promise<T>
  transaction<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Required namespace, validated before acquiring a connection or issuing SQL.
 * PostgreSQL identifiers have a 63-byte limit; refusing longer names avoids
 * silent truncation and collisions. ASCII also makes byte length unambiguous. */
export function validateSchema(schema: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema))
    throw new TypeError('Durable PostgreSQL schema must be a plain identifier of at most 63 bytes')
}

/** Pi src/storage/sqlite/storage.ts numeric rows and src/ids.ts:idFromNumber.
 * PostgreSQL returns BIGINT text; reject unsafe integers before numeric conversion.
 * SQLite INTEGER is signed 64-bit, so document versions also require BIGINT. */
export function safeNumber(value: string): number {
  const integer = BigInt(value)
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError("Durable PostgreSQL integer exceeds JavaScript's safe range")
  return Number(integer)
}
