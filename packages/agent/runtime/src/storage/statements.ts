import type { RecordKindName, Statement, SqlValue } from './database.ts'

/**
 * The ordered writes of one segment of a commit, planned before they are sent. Pi's SQLite
 * storage issues them one at a time (`applyTableWrite`, `applyDocumentActions`); here they go as
 * one batch, in the same order, with every repeated upsert kept. A plan is not an acknowledgement:
 * nothing is written until the driver sends it inside the transaction.
 */
export class Statements {
  readonly values: Statement[] = []
  /** Keep the statement and its bindings in order, including repeated mutable ids. */
  run(recordKind: RecordKindName, sql: string, ...params: SqlValue[]): void {
    this.values.push({ recordKind, sql, params })
  }
}
