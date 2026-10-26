/**
 * The parts of the Durable Object API this cell uses, typed structurally: celld implements
 * Cloudflare's API (`refs/celld/docs/services/durable-objects.md`) and the repository carries no
 * Workers type package. Names follow Cloudflare's own (`DurableObjectState`, `SqlStorage`).
 */
export type SqlValue = ArrayBuffer | string | number | null

export interface CellStorage {
  readonly sql: {
    exec(query: string, ...bindings: Array<SqlValue>): { toArray(): Array<Record<string, SqlValue>> }
  }
  /** Commits when the closure resolves and rolls back when it rejects; 30 s cap on celld. */
  transaction<T>(closure: () => Promise<T>): Promise<T>
  /** Resolves once every earlier committed write is durable (followers or the object store). */
  sync(): Promise<void>
}

export interface CellState {
  readonly id: { readonly name?: string | undefined }
  readonly storage: CellStorage
  /** Closes the input gate until the callback settles; 30 s cap on celld. */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

export interface PersonNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** The bindings `wrangler.jsonc` and the fleet script's `vars` give the Worker and the cell. */
export interface CellEnv {
  readonly PERSON: PersonNamespace
  readonly [variable: string]: unknown
}
