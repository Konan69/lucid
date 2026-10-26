import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { CellStorage } from './cloudflare.ts'

/**
 * Proof instrumentation, not product code: what Pi's commits cost inside one cell. Pi's adapter
 * calls only `sql.exec` and `transaction` (`pi-durable/dist/storage/sqlite/cloudflare.js`), so
 * this wraps exactly those two and hands Pi the wrapped storage.
 *
 * celld's clocks advance only at an I/O boundary (`cloudflare-compat.md`, Performance and timers),
 * so a transaction's measured time is the I/O it waited on, not its CPU time. What a write costs a
 * two-node fleet is its durability wait (the follower's ack, then the bucket), which a transaction
 * does not include: celld holds the response, not the commit. So after each commit `sync()` is
 * timed in the background; it adds no write, it only waits for earlier ones to be durable.
 */
export interface Commit {
  readonly at: number
  readonly ms: number
  readonly statements: number
  readonly writes: number
  readonly failed: boolean
}

export interface Meter {
  readonly storage: DurableObjectSqliteStorage
  readonly snapshot: () => {
    readonly commits: ReadonlyArray<Commit>
    readonly durable: ReadonlyArray<number>
    readonly syncErrors: ReadonlyArray<string>
    readonly outside: { readonly statements: number; readonly writes: number }
  }
  readonly reset: () => void
}

const WRITE = /^\s*(insert|update|delete|replace|create|drop|alter)\b/iu

export const meter = (storage: CellStorage): Meter => {
  let commits: Array<Commit> = []
  let durable: Array<number> = []
  let syncErrors: Array<string> = []
  let outside = { statements: 0, writes: 0 }
  let open: { statements: number; writes: number } | null = null

  const exec: CellStorage['sql']['exec'] = (query, ...bindings) => {
    const counter = open ?? outside
    counter.statements += 1
    if (WRITE.test(query)) counter.writes += 1
    return storage.sql.exec(query, ...bindings)
  }

  const transaction = async <T>(closure: () => Promise<T>): Promise<T> => {
    const counter = { statements: 0, writes: 0 }
    open = counter
    const started = Date.now()
    let failed = false
    try {
      return await storage.transaction(closure)
    } catch (error) {
      failed = true
      throw error
    } finally {
      open = null
      commits.push({ at: started, ms: Date.now() - started, ...counter, failed })
      if (!failed && counter.writes > 0) {
        const waited = Date.now()
        storage.sync().then(
          () => durable.push(Date.now() - waited),
          (error: unknown) => syncErrors.push(error instanceof Error ? error.message : String(error)),
        )
      }
    }
  }

  return {
    storage: { sql: { exec }, transaction },
    snapshot: () => ({ commits, durable, syncErrors, outside }),
    reset: () => {
      commits = []
      durable = []
      syncErrors = []
      outside = { statements: 0, writes: 0 }
    },
  }
}
