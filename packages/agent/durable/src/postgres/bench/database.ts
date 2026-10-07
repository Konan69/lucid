import type * as Option from 'effect/Option'
import type { PostgresDatabase, PostgresExecutor, PostgresValue, PostgresStatement } from '../database.ts'

/** Test-only facade counter: every executor SQL call maps to one driver query;
 * successful transactions add BEGIN and COMMIT. No product instrumentation. */
export class CountingDatabase implements PostgresDatabase {
  calls = 0
  constructor(private readonly database: PostgresDatabase) {}
  /** One unbound driver query. */
  exec(sql: string): Promise<void> { this.calls++; return this.database.exec(sql) }
  /** One bound driver query. */
  run(sql: string, ...params: PostgresValue[]): Promise<void> { this.calls++; return this.database.run(sql, ...params) }
  /** Preserve genuine row absence. */
  get<T extends object>(sql: string, ...params: PostgresValue[]): Promise<Option.Option<T>> { this.calls++; return this.database.get<T>(sql, ...params) }
  /** Preserve row order. */
  all<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T[]> { this.calls++; return this.database.all<T>(sql, ...params) }
  /** One ordered batch still makes exactly one driver query call. */
  runBatch(statements: readonly PostgresStatement[]): Promise<void> {
    this.calls++
    return this.database.runBatch(statements)
  }
  /** Count the real transaction handle, never a fake driver. */
  transaction<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T> {
    this.calls += 2
    return this.database.transaction((transaction) => callback(this.executor(transaction)))
  }
  /** BEGIN and preflight reads are one driver call, COMMIT is one more. */
  transactionWithReads<T>(reads: readonly PostgresStatement[], callback: (transaction: PostgresExecutor, rows: readonly (readonly object[])[]) => Promise<T>): Promise<T> {
    this.calls += 2
    return this.database.transactionWithReads(reads, (transaction, rows) => callback(this.executor(transaction), rows))
  }
  /** Count public facade operations on the actual leased transaction. */
  private executor(transaction: PostgresExecutor): PostgresExecutor {
    return {
      exec: (sql) => { this.calls++; return transaction.exec(sql) },
      run: (sql, ...params) => { this.calls++; return transaction.run(sql, ...params) },
      runBatch: (statements) => { this.calls++; return transaction.runBatch(statements) },
      get: (sql, ...params) => { this.calls++; return transaction.get(sql, ...params) },
      all: (sql, ...params) => { this.calls++; return transaction.all(sql, ...params) },
    }
  }
  /** Cleanup is outside every sample. */
  close(): Promise<void> { return this.database.close() }
}
