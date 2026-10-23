import { openPostgresPool } from 'alchemy/SQL/PostgresDriver'
import { getTableName } from 'drizzle-orm'
import * as Array from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import {
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type AbortableOperationOptions,
  type DatabaseConnection,
  type DeleteQueryNode,
  type Dialect,
  type Driver,
  type OperationNode,
  type QueryCompiler,
  type ReturningNode,
  type TableNode,
  type TransactionSettings,
} from 'kysely'
import type { Pool } from 'pg'
import { PersonId } from '@vivid/contracts'
import { CHANNEL, notificationPayloads, Topic } from '../live/changes.ts'
import { sessionTable } from './tables.ts'

/**
 * Better Auth's database, with one addition: removing a session announces its Person in the same
 * commit.
 *
 * Why here. A subscription that outlives its session is ended by the Person's topic moving
 * (`live/query.ts` `sessionEnded`). Better Auth's `databaseHooks` run after the delete has
 * committed and read their audience with a 100-row cap (better-auth 1.7.5
 * `db/with-hooks.mjs:116-188`, `@better-auth/core` `db/adapter/factory.mjs:594`), so a crash
 * between the two loses the notice and a wide revoke names only some owners. The only public seam
 * that sees the statement on its own connection is Kysely's `Dialect`: Better Auth accepts
 * `{ dialect, type, transaction }` and builds its official Kysely adapter over it
 * (`@better-auth/kysely-adapter` 1.7.5 `dist/index.mjs:50-60`), so the adapter object, its schema
 * check (registered by identity, `:709-714`), its CRUD and its hooks are untouched.
 *
 * What it does. Kysely hands every compiled query to `DatabaseConnection.executeQuery` together
 * with its operation node. A `DELETE` on the session table is run with `RETURNING` of the owner
 * column, and one `pg_notify` per payload follows on the same connection inside one transaction.
 * The owners are the rows that statement removed: a receipt, never a prior read, so there is no
 * cap, no window and no notice for a row someone else removed.
 *
 * Coupling, to re-read when the Better Auth or Kysely pin moves (kysely 0.29.5 today):
 * 1. Better Auth removes sessions with a Kysely delete on the bare session table
 *    (`@better-auth/kysely-adapter` `dist/index.mjs:596-647`: `delete`, `deleteMany`,
 *    `consumeOne`). Raw SQL, another service, and the `ON DELETE CASCADE` from a removed Person
 *    row never pass through here and are not announced.
 * 2. Kysely's delete builder returns `DeleteResult(numAffectedRows)` and ignores driver rows when
 *    its own node has no `returning` (`query-builder/delete-query-builder.js:445-455`), which is
 *    why handing back no rows after adding the receipt changes nothing for the caller.
 * 3. The node shapes read below (`from.froms`, `table.identifier.name`, `returning`). They are
 *    exported, unmarked interface types; the node factories (`DeleteQueryNode.is`, `TableNode.is`,
 *    `QueryNode.cloneWithReturning`) are `@internal` and are not used. A changed shape fails the
 *    typecheck or rejects the delete; it cannot silently skip a notice.
 * 4. A transaction is seen only through `Driver.beginTransaction`. A `begin` sent as SQL text
 *    would leave this connection `Idle`. The official adapter sends none.
 *
 * This file is the narrow Promise adapter Kysely's contract requires and nothing else. It has no
 * asynchronous function and no rejection handler: every unsafe call is one `Effect.tryPromise`,
 * and the removal is one Effect program run at the one driver callback that must return a Promise
 * (`settle`).
 */

/** The steps of a removal that talk to PostgreSQL, named so a failure says which one it was. */
const RemovalStep = Schema.Literals(['begin', 'remove', 'announce', 'commit', 'rollback'])
type RemovalStep = typeof RemovalStep.Type

/**
 * PostgreSQL or the driver rejected a removal step. A rejected commit does not establish whether
 * PostgreSQL committed; preserve the failure without claiming the session is still present.
 */
export class SessionRemovalFailed extends Schema.TaggedError<SessionRemovalFailed>()(
  'SessionRemovalFailed',
  { step: RemovalStep, cause: Schema.Defect() },
  { title: 'Session removal failed' },
) {}

/**
 * A removed session row did not name its Person. Only a `returning` this file did not add can omit
 * the owner column; the removal is refused rather than committed without its notice. Carries no
 * row data: a session row holds the session token.
 */
export class SessionOwnerUnreadable extends Schema.TaggedError<SessionOwnerUnreadable>()(
  'SessionOwnerUnreadable',
  {},
  { title: 'Removed session has no readable owner' },
) {}

/**
 * A delete this file cannot place on exactly one unqualified table. It might remove sessions under
 * an alias, a schema or a join, so it is refused instead of passed through unannounced.
 */
export class UnrecognisedDelete extends Schema.TaggedError<UnrecognisedDelete>()(
  'UnrecognisedDelete',
  {},
  { title: 'Delete statement is not recognised' },
) {}

/** Kysely's public builder produced no `returning` node, so no removal could be announced. */
export class SessionReceiptUnavailable extends Schema.TaggedError<SessionReceiptUnavailable>()(
  'SessionReceiptUnavailable',
  {},
  { title: 'Session removal receipt is unavailable' },
) {}

/** The driver was handed a connection it did not acquire, so its transaction state is unknown. */
export class ForeignConnection extends Schema.TaggedError<ForeignConnection>()(
  'ForeignConnection',
  {},
  { title: 'Connection was not acquired from this driver' },
) {}

/**
 * Whether Kysely has a transaction open on a connection. A removal joins an open one and brackets
 * itself otherwise. Each acquire makes a new connection object, which starts `Idle`: the pool never
 * hands out a client that is inside a transaction.
 */
const TransactionState = Schema.TaggedUnion({ Idle: {}, Open: {} })
type TransactionState = typeof TransactionState.Type

/**
 * What a delete statement means to this dialect.
 *
 * - `OtherTable`: one unqualified table that is not the session table. Runs unchanged.
 * - `Unrecognised`: anything else. Refused (`UnrecognisedDelete`).
 * - `Removal`: sessions, no `returning` in the official node (`delete`, `deleteMany`). The receipt
 *   is added and the rows are withheld from the builder.
 * - `ReturningRemoval`: sessions, the official node already returns rows (`consumeOne`,
 *   `returningAll`). Runs unchanged and the owners are read from its own rows.
 */
const DeleteTarget = Schema.TaggedUnion({
  OtherTable: {},
  Unrecognised: {},
  Removal: {},
  ReturningRemoval: {},
})
type DeleteTarget = typeof DeleteTarget.Type

/** What a session removal is recognised by, and the receipt it is run with. */
interface Removal {
  /** The session table's name, from the Drizzle schema. */
  readonly table: string
  /** The column naming the Person who owns a session, from the Drizzle schema. */
  readonly column: string
  /** `returning "<column>"`, as Kysely's own builder made it. */
  readonly receipt: ReturningNode
}

/**
 * A Kysely with no database, as documented in "Splitting query building and execution"
 * (kysely.dev/docs/recipes/splitting-query-building-and-execution). It only builds nodes: nothing
 * built on it is ever executed, and `DummyDriver` could not execute it. Its one table is typed from
 * the Drizzle session table.
 */
const cold = new Kysely<
  Record<(typeof sessionTable)['_']['name'], typeof sessionTable.$inferSelect>
>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

/**
 * Names come from `auth/tables.ts`, never from a literal. The receipt is taken once from a tree
 * Kysely's public builder made (`toOperationNode`, shown in `operation-node-transformer.d.ts:135`),
 * so no node is built by hand and no `@internal` factory is called. `returning` is optional on the
 * node type; if the builder ever stops producing it the auth database fails to build rather than
 * removing sessions without a notice. Drizzle types a column's database name as `string`, so the
 * column is given to the builder through Kysely's documented runtime reference (`dynamic.ref`).
 */
const sessionRemoval = Effect.fn('AuthDialect.sessionRemoval')(function* () {
  const table = getTableName(sessionTable)
  const column = sessionTable.userId.name
  const receipt = cold
    .deleteFrom(table)
    .returning(cold.dynamic.ref(column))
    .toOperationNode().returning
  if (receipt === undefined) return yield* new SessionReceiptUnavailable({})
  const removal: Removal = { table, column, receipt }
  return removal
})

/**
 * `froms` is `ReadonlyArray<OperationNode>`, which is not a union, so TypeScript cannot narrow it
 * by itself. This states the same fact as `TableNode`'s own `kind` literal; Kysely's `TableNode.is`
 * does the same comparison but is `@internal`.
 */
const isTable = (node: OperationNode): node is TableNode => node.kind === 'TableNode'

/**
 * Places a delete (closed, see `DeleteTarget`). Recognised means exactly one `from` item that is a
 * `TableNode` with no schema, and no `using` or `joins`: the only shape the official adapter
 * writes (`db.deleteFrom(model)`). An alias is an `AliasNode`, so it is not recognised.
 */
const deleteTarget = (node: DeleteQueryNode, removal: Removal): DeleteTarget => {
  const [from, ...more] = node.from.froms
  if (from === undefined || more.length > 0 || !isTable(from)) {
    return DeleteTarget.cases.Unrecognised.make({})
  }
  if (from.table.schema !== undefined || node.using !== undefined || node.joins !== undefined) {
    return DeleteTarget.cases.Unrecognised.make({})
  }
  if (from.table.identifier.name !== removal.table) return DeleteTarget.cases.OtherTable.make({})
  return node.returning === undefined
    ? DeleteTarget.cases.Removal.make({})
    : DeleteTarget.cases.ReturningRemoval.make({})
}

/** Returned rows are driver output: decoded once here, and only the owner column is read. */
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeOwner = Schema.decodeUnknownEffect(PersonId)

/**
 * One Promise call of the driver as an Effect. The rejection is kept as `cause` and never printed
 * here. `PromiseLike` is the type `Effect.tryPromise` itself asks for.
 *
 * A declaration keeps this generic adapter and its exact audit owner visible without a nested
 * runtime boundary at each call site.
 */
function attempt<A>(step: RemovalStep, run: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new SessionRemovalFailed({ step, cause }),
  })
}

/**
 * The one place an Effect becomes a Promise: Kysely's `Driver` and `DatabaseConnection` are
 * Promise interfaces that fail by rejection, and `executeQuery` is the callback that must return
 * one. It replaces the terminal the `databaseHooks` callback in `auth/provider.ts` used to hold.
 * The runtime rejects with the typed failure itself (rc.116 `internal/effect.ts:5701-5723`), so
 * Better Auth sees a rejected query, as it would from the driver.
 */
const settle = <A, E>(program: Effect.Effect<A, E>) =>
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Kysely's Promise-only driver callback is this adapter's runtime edge.
  Effect.runPromise(program)

/**
 * Announces the owners of the rows a removal returned, on the connection that removed them. Fails
 * without announcing when a row has no readable owner or an owner cannot fit a payload
 * (`notificationPayloads`); the transaction around it then rolls the delete back. No rows means no
 * owner, no payload and no notice.
 */
const announceOwners = Effect.fn('AuthDialect.announceOwners')(function* (
  connection: DatabaseConnection,
  removed: ReadonlyArray<unknown>,
  column: string,
) {
  const owners = yield* decodeRows(removed).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeOwner(row[column]))),
    Effect.mapError(() => new SessionOwnerUnreadable({})),
  )
  const payloads = yield* notificationPayloads(
    Array.dedupe(owners).map((owner) => Topic.person(owner)),
  )
  yield* Effect.forEach(
    payloads,
    (payload) =>
      attempt('announce', () =>
        connection.executeQuery(CompiledQuery.raw('select pg_notify($1, $2)', [CHANNEL, payload])),
      ),
    { discard: true },
  )
})

/**
 * One checked-out PostgreSQL connection as Kysely sees it. It passes every query to Kysely's own
 * connection except a delete, which it places with `deleteTarget`.
 *
 * It offers what the official connection's callers use and no more: `cancelQuery`, `killSession`
 * and `collectSessionInfo` are optional in Kysely's contract and exist for abort signals, which
 * the official adapter never passes (`@better-auth/kysely-adapter` `dist/index.mjs` has no
 * `signal`). Leaving them out makes an aborted query fail loudly in Kysely (`util/abort.js:9-20`)
 * instead of cancelling half of a removal.
 */
class AnnouncingConnection implements DatabaseConnection {
  readonly #inner: DatabaseConnection
  readonly #driver: Driver
  readonly #compiler: QueryCompiler
  readonly #removal: Removal
  #transaction: TransactionState = TransactionState.cases.Idle.make({})

  constructor(
    inner: DatabaseConnection,
    driver: Driver,
    compiler: QueryCompiler,
    removal: Removal,
  ) {
    this.#inner = inner
    this.#driver = driver
    this.#compiler = compiler
    this.#removal = removal
  }

  /** Kysely opened a transaction on this connection; removals inside it join it. */
  begin(settings: TransactionSettings) {
    return this.#driver.beginTransaction(this.#inner, settings).then(() => {
      this.#transaction = TransactionState.cases.Open.make({})
    })
  }

  /** A rejected commit leaves `Open`; Kysely then rolls back (`kysely.js:678-687`), which closes it. */
  commit() {
    return this.#driver.commitTransaction(this.#inner).then(() => {
      this.#transaction = TransactionState.cases.Idle.make({})
    })
  }

  rollback() {
    return this.#driver.rollbackTransaction(this.#inner).then(() => {
      this.#transaction = TransactionState.cases.Idle.make({})
    })
  }

  /** Kysely's driver releases by a private member of its own connection, so it gets that one. */
  release(options?: AbortableOperationOptions) {
    return this.#driver.releaseConnection(this.#inner, options)
  }

  /**
   * `kind` is the declared discriminant of `RootOperationNode`, so this comparison narrows to
   * `DeleteQueryNode` with no cast and no `@internal` factory. It is the SDK's vocabulary read at
   * its ingress, not a Vivid state; the Vivid decision that follows is the closed `DeleteTarget`.
   */
  executeQuery<R>(compiled: CompiledQuery) {
    const query = compiled.query
    if (query.kind !== 'DeleteQueryNode') return this.#inner.executeQuery<R>(compiled)
    return DeleteTarget.match(deleteTarget(query, this.#removal), {
      OtherTable: () => this.#inner.executeQuery<R>(compiled),
      Unrecognised: () => settle(Effect.fail(new UnrecognisedDelete({}))),
      /**
       * The receipt is added by object spread of the official node, the form Kysely documents for
       * changing a node (`operation-node-transformer.d.ts:116-128`), and compiled by the wrapped
       * dialect's own compiler under the official query id. The rows are withheld so the builder
       * sees the driver result it expects from a delete without `returning` (coupling point 2).
       */
      Removal: () =>
        settle(
          Effect.sync(() =>
            this.#compiler.compileQuery(
              { ...query, returning: this.#removal.receipt },
              compiled.queryId,
            ),
          ).pipe(
            Effect.flatMap((statement) => this.#remove<R>(statement)),
            Effect.map((result) => ({ ...result, rows: [] })),
          ),
        ),
      ReturningRemoval: () => settle(this.#remove<R>(compiled)),
    })
  }

  /**
   * Passed through. The wrapped dialect is built without a `cursor`, so Kysely's connection
   * refuses every stream before it reaches PostgreSQL (`postgres-driver.js` `streamQuery`); a
   * streamed delete cannot remove a session unannounced.
   */
  streamQuery<R>(compiled: CompiledQuery, chunkSize: number) {
    return this.#inner.streamQuery<R>(compiled, chunkSize)
  }

  /**
   * The delete and its notices as one commit.
   *
   * `Open`: Kysely owns the transaction, so the removal only adds its statements; a failure goes
   * to that owner, which rolls back. `Idle`: the delete would autocommit before its notice, so the
   * removal brackets itself with the wrapped driver's own begin, commit and rollback, in the order
   * of Kysely's transaction (`kysely.js:668-692`): any failure after begin rolls back and then
   * fails with the first failure, and a failed rollback is the failure reported. PostgreSQL sends
   * a notification only at commit and drops it on rollback, so the notice and the removal cannot
   * part. Only this connection is used, never another one from the pool.
   */
  #remove<R>(statement: CompiledQuery) {
    const removal = attempt('remove', () => this.#inner.executeQuery<R>(statement)).pipe(
      Effect.tap((result) => announceOwners(this.#inner, result.rows, this.#removal.column)),
    )
    return TransactionState.match(this.#transaction, {
      Open: () => removal,
      Idle: () =>
        attempt('begin', () => this.#driver.beginTransaction(this.#inner, {})).pipe(
          Effect.andThen(
            removal.pipe(
              Effect.tap(() =>
                attempt('commit', () => this.#driver.commitTransaction(this.#inner)),
              ),
              Effect.tapCause(() =>
                attempt('rollback', () => this.#driver.rollbackTransaction(this.#inner)),
              ),
            ),
          ),
        ),
    })
  }
}

/**
 * Kysely passes back the connection `acquireConnection` returned, typed as the interface.
 * `instanceof` on this module's own class is the check; anything else is refused, because its
 * transaction state would be a guess.
 */
function owned<A>(connection: DatabaseConnection, use: (ours: AnnouncingConnection) => Promise<A>) {
  return connection instanceof AnnouncingConnection
    ? use(connection)
    : settle(Effect.fail(new ForeignConnection({})))
}

/**
 * Kysely's PostgreSQL driver, with each acquired connection wrapped. Pool handling, connection
 * reuse and the transaction statements stay Kysely's (`dialect/postgres/postgres-driver.js`).
 *
 * Savepoints are optional in Kysely's `Driver` and are left out: the official adapter uses
 * `db.transaction().execute` only, and without them Kysely refuses a savepoint
 * (`driver/runtime-driver.js`) instead of nesting a removal in one.
 */
class AnnouncingDriver implements Driver {
  readonly #inner: Driver
  readonly #compiler: QueryCompiler
  readonly #removal: Removal

  constructor(inner: Driver, compiler: QueryCompiler, removal: Removal) {
    this.#inner = inner
    this.#compiler = compiler
    this.#removal = removal
  }

  init(options?: AbortableOperationOptions) {
    return this.#inner.init(options)
  }

  /** A new wrapper per acquire, so its transaction state starts `Idle` with the checkout. */
  acquireConnection(options?: AbortableOperationOptions) {
    return this.#inner
      .acquireConnection(options)
      .then(
        (connection) =>
          new AnnouncingConnection(connection, this.#inner, this.#compiler, this.#removal),
      )
  }

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
    return owned(connection, (ours) => ours.begin(settings))
  }

  commitTransaction(connection: DatabaseConnection) {
    return owned(connection, (ours) => ours.commit())
  }

  rollbackTransaction(connection: DatabaseConnection) {
    return owned(connection, (ours) => ours.rollback())
  }

  releaseConnection(connection: DatabaseConnection, options?: AbortableOperationOptions) {
    return owned(connection, (ours) => ours.release(options))
  }

  destroy(options?: AbortableOperationOptions) {
    return this.#inner.destroy(options)
  }
}

/**
 * Kysely's `PostgresDialect` over the given pool, with the announcing driver. The compiler, the
 * adapter and the introspector (which Better Auth's schema check reads through) are Kysely's own.
 */
const announcingDialect = (pool: Pool, removal: Removal): Dialect => {
  const inner = new PostgresDialect({ pool })
  return {
    createAdapter: () => inner.createAdapter(),
    createDriver: () =>
      new AnnouncingDriver(inner.createDriver(), inner.createQueryCompiler(), removal),
    createIntrospector: (database) => inner.createIntrospector(database),
    createQueryCompiler: () => inner.createQueryCompiler(),
  }
}

/**
 * How many connections Better Auth may hold at once: node-postgres's own default (`pg-pool`
 * `index.js`, `max: 10`), the same as the server's own pool. Every request that names a session
 * asks Better Auth, so one connection would queue them all behind each other.
 */
const AUTH_CONNECTIONS = 10

/**
 * Keeps a lost idle connection from ending the server. The pool lives as long as the server, so
 * its idle connections meet PostgreSQL restarting, a failover or a dropped socket. node-postgres
 * then removes the broken client and emits `error` on the pool (`pg-pool` `index.js`,
 * `idleListener`); an `error` event nobody listens to is thrown by Node's `EventEmitter` and ends
 * the process. Neither alchemy's `openPostgresPool` nor Kysely's driver listens. The next query
 * opens a fresh connection, so all there is to do is say it happened. Only the error's code is
 * logged: its message can name the connection.
 */
const heedIdleFailures = Effect.fn('AuthDialect.heedIdleFailures')(function* (pool: Pool) {
  const lost = yield* Queue.unbounded<Error & { readonly code?: string }>()
  const heard = (error: Error & { readonly code?: string }) => {
    Queue.offerUnsafe(lost, error)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => pool.on('error', heard)),
    () => Effect.sync(() => pool.off('error', heard)),
  )
  yield* Queue.take(lost).pipe(
    Effect.flatMap((error) =>
      Effect.logWarning('Auth database lost an idle connection; the pool opens another', {
        code: error.code,
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  )
})

/**
 * Better Auth's database for Vivid's PostgreSQL: one `pg.Pool`, opened on the caller's scope and
 * ended when that scope closes (`openPostgresPool`, alchemy `SQL/PostgresDriver.ts`). The caller is
 * the server's auth Layer, so the pool lives as long as the server (`provider.ts`).
 *
 * Better Auth is given the dialect form, for which `transaction` must be passed explicitly: only
 * the bare-pool form sets it (`@better-auth/kysely-adapter` `dist/index.mjs:66-69`). Vivid's schema
 * is owned by Drizzle, so nothing here migrates.
 */
export const authDatabase = Effect.fn('AuthDialect.database')(function* (url: Redacted.Redacted) {
  const removal = yield* sessionRemoval()
  const pool = yield* openPostgresPool(Effect.succeed(url), { max: AUTH_CONNECTIONS })
  yield* heedIdleFailures(pool)
  return { dialect: announcingDialect(pool, removal), type: 'postgres', transaction: true } as const
})
