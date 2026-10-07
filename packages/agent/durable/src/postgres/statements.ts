import type { PostgresStatement, PostgresValue } from './database.ts'

/** Pi src/storage/sqlite/storage.ts:applyTableWrite/applyDocumentActions issue
 * only ordered writes within each write segment. Prepare those statements before
 * sending a batch; this is a pure SQL plan, never an executor that acknowledges
 * unexecuted writes. Valid Storage records already contain JSON-compatible data.
 * Reads and copy validation stay outside this buffer at their reference positions. */
export class Statements {
  readonly values: PostgresStatement[] = []
  /** Retain every statement and binding in order, including repeated mutable ids. */
  run(sql: string, ...params: PostgresValue[]): void {
    this.values.push({ sql, params })
  }
}
