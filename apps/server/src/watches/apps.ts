import { and, eq, isNull, ne, or } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import { CompanyId, ConnectionId, DatabaseFailure, WatchArguments } from '@vivid/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import type { Actor } from '../auth/access.ts'
import {
  Executor,
  ExecutorAppOwnership,
  ExecutorReferences,
  type ExecutorAppId,
} from '../connections/executor.ts'
import { decodeRow, listRecords, type ConnectionRecord } from '../connections/records.ts'
import { namedAccounts } from '../connections/names.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { ExecutorEventsUnreachable, type Subscription } from './events.ts'
import { connections } from '../connections/tables.ts'
import { watches } from './tables.ts'

/**
 * Which Executor app an Integration account runs on, by the name the Person was shown, and
 * whether that app is the account's alone.
 *
 * A Watch subscribes to `<app slug>.<event>` with Vivid's one Executor key, and Executor's
 * delivery names no account, so the app is the only thing that says whose an event is. An account
 * is watchable only when its app is dedicated to its Connection. Since Executor beta.23 every
 * live Connection installs an app of its own (`makeBegin` in `connections/executor.ts`) and
 * claims it in `executor_app`, which a unique index holds to one Connection
 * (`vivid_connections_executor_app` in `connections/tables.ts`); `claimedApp` in
 * `connections/records.ts` names that claim, and only the live selections, `Public` and
 * `Authorized` when ready, have one. A selection carried over from before beta.23 whose app was or
 * may have been shared with other accounts (`ReconnectRequired`) claims no app and is refused, so
 * an event from a watched app belongs to that one Connection and the Person who holds it.
 *
 * Executor names events by the app's slug, while a Connection stores the app's immutable id. The
 * slug is read from Executor's app record (`AppFields.slug`, executor@2.0.0-beta.23
 * `packages/sdk/src/contracts/apps.ts`), because a rename changes it and nothing in Vivid stores it.
 *
 * This is the one place Watches depend on how Connections are stored.
 */

/** No Integration account of this Person has this name. */
export class WatchAccountUnknown extends Schema.TaggedError<WatchAccountUnknown>()(
  'WatchAccountUnknown',
  {},
  { title: 'Watch account unknown' },
) {}
/** The account exists but is not connected and ready, so it cannot be watched yet. */
export class WatchAccountNotReady extends Schema.TaggedError<WatchAccountNotReady>()(
  'WatchAccountNotReady',
  {},
  { title: 'Watch account not ready' },
) {}
/**
 * The account runs on an app that was, or may have been, shared with other accounts: a selection
 * from before each Connection had its own app. Events from it could be anyone's, so it is not
 * watched until it is connected again.
 */
export class WatchAccountShared extends Schema.TaggedError<WatchAccountShared>()(
  'WatchAccountShared',
  {},
  { title: 'Watch account shared' },
) {}

/** An account and the slug of the app dedicated to it. */
export interface WatchedApp {
  readonly connectionId: ConnectionId
  readonly appSlug: string
}

export interface WatchedAppsService {
  /** The account's app, resolved now. */
  readonly appOf: (
    actor: Actor,
    account: string,
  ) => Effect.Effect<
    WatchedApp,
    | WatchAccountUnknown
    | WatchAccountNotReady
    | WatchAccountShared
    | ExecutorEventsUnreachable
    | DatabaseInfrastructureError
  >
  /** The names of the Actor's watchable accounts, to say which ones exist when a name matches none. */
  readonly accountsOf: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<string>, DatabaseInfrastructureError>
}

export class WatchedApps extends Context.Service<WatchedApps, WatchedAppsService>()(
  'vivid/WatchedApps',
) {}

/** The app a Connection may be watched on, or why it may not. */
type Dedicated = Result.Result<typeof ExecutorAppId.Type, WatchAccountNotReady | WatchAccountShared>

const notReady = (): Dedicated => Result.fail(new WatchAccountNotReady({}))
const shared = (): Dedicated => Result.fail(new WatchAccountShared({}))

/**
 * A live selection's app, once its Connection is ready. The app must be provably this
 * Connection's alone: one installed for it, or a copy made for it from a shared original
 * (`ExecutorAppOwnership`). An app carried over that may still hold other accounts is
 * `Unproven`, and its events could be anyone's.
 */
const ready = (
  row: ConnectionRecord,
  app: typeof ExecutorAppId.Type,
  ownership: typeof ExecutorAppOwnership.Type,
): Dedicated => {
  if (ExecutorAppOwnership.guards.Unproven(ownership)) return shared()
  return row.status === 'ready' ? Result.succeed(app) : notReady()
}

/**
 * The app dedicated to this Connection, or why it has none to watch. A live selection claims its
 * own app; it is watchable once ready. A selection still to be migrated, or mid sign-in, is not
 * ready yet. One that must be connected again kept no proof its app was its own.
 */
const dedicatedApp = (row: ConnectionRecord): Dedicated =>
  ExecutorReferences.match(row.references, {
    Public: ({ app, appOwnership }) => ready(row, app, appOwnership),
    Authorized: ({ app, appOwnership }) => ready(row, app, appOwnership),
    ReconnectRequired: shared,
    MigrationPending: notReady,
    EnteringKey: notReady,
    SigningIn: notReady,
    OAuthSigningIn: notReady,
    GoogleSigningIn: notReady,
  })

/** Build on the Connection adapter's authenticated app reader. */
export const makeWatchedApps = (database: Database['Service'], executor: Executor['Service']) => {
  /**
   * The Actor's OWN Integration accounts, under the names the Integration list shows them by. The
   * whole inventory is named first, a Company's shared Connections included, because each name's
   * ordinal and suffix depend on all of it (`connections/store.ts` `list`, `connections/tools.ts`);
   * naming only the Actor's rows would call their "Mail (2)" "Mail". Then another Member's
   * accounts drop out: a Watch runs on its account's credentials for this Person alone.
   */
  const accounts = (actor: Actor) =>
    listRecords(actor).pipe(
      Effect.map((rows) =>
        namedAccounts(rows).filter((item) => item.row.personId === actor.person.id),
      ),
      Effect.provideService(Database, database),
    )

  return WatchedApps.of({
    /** Account names compare as the Connection tools compare them: trimmed, case-insensitive. */
    appOf: Effect.fn('WatchedApps.appOf')(function* (actor, account) {
      const wanted = account.trim().toLowerCase()
      const found = (yield* accounts(actor)).find((item) => item.account.toLowerCase() === wanted)
      if (found === undefined) return yield* new WatchAccountUnknown({})
      const app = yield* Effect.fromResult(dedicatedApp(found.row))
      const appSlug = yield* executor
        .appSlug(app)
        .pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
      return { connectionId: found.row.id, appSlug }
    }),
    accountsOf: Effect.fn('WatchedApps.accountsOf')(function* (actor) {
      return (yield* accounts(actor)).flatMap((item) =>
        Result.isSuccess(dedicatedApp(item.row)) ? [item.account] : [],
      )
    }),
  })
}

/** Connection storage and Executor authority are shared with Integrations. */
export const watchedAppsLayer = Layer.effect(
  WatchedApps,
  Effect.gen(function* () {
    return makeWatchedApps(yield* Database, yield* Executor)
  }),
)

/** The transaction type is owned by Database, including its driver error channel. */
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/** Creation and removal lock the same identity, so a stale account resolution cannot revive it. */
export const holdConnection = Effect.fn('WatchedApps.holdConnection')(function* (
  tx: Transaction,
  id: ConnectionId,
) {
  const rows = yield* tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.removedAt)))
    .for('update')
  if (rows.length === 0) return yield* new WatchAccountNotReady({})
})

/**
 * Name the current inventory in the Watch's workspace, exactly as the Integration list does.
 * A removed target is included only to name its own history; other tombstones never shift ordinals.
 */
export const accountOf = Effect.fn('WatchedApps.accountOf')(function* (
  id: ConnectionId,
  companyId: CompanyId | null,
) {
  const database = yield* Database
  const target = yield* database.run(
    database.select().from(connections).where(eq(connections.id, id)).limit(1),
  )
  const connection = yield* decodeRow(yield* returned(target, 'Watch Connection'))
  const personal = and(eq(connections.personId, connection.personId), isNull(connections.companyId))
  const scope = companyId === null ? personal : or(personal, eq(connections.companyId, companyId))
  const rows = yield* database.run(
    database
      .select()
      .from(connections)
      .where(or(eq(connections.id, id), and(isNull(connections.removedAt), scope))),
  )
  const named = namedAccounts(yield* Effect.forEach(rows, decodeRow)).find(
    (item) => item.row.id === id,
  )
  if (named === undefined)
    return yield* new DatabaseFailure({ message: 'Watch Connection has no name' })
  return named.account
})

const decodeArguments = decodeStored(WatchArguments, 'Watch arguments')

/**
 * Stop every live Watch while the caller holds its Connection row lock. History tells the
 * Connection owner to retain its identity; the subscription keys are reclaimed after commit.
 */
export const disconnectWatches = Effect.fn('WatchedApps.disconnectWatches')(function* (
  tx: Transaction,
  id: ConnectionId,
) {
  const now = yield* Clock.currentTimeMillis
  const stopped = yield* tx
    .update(watches)
    .set({ state: 'Stopped', stopReason: 'disconnected', updatedAt: now })
    .where(and(eq(watches.connectionId, id), ne(watches.state, 'Stopped')))
    .returning()
  const history = yield* tx
    .select({ id: watches.id })
    .from(watches)
    .where(eq(watches.connectionId, id))
    .limit(1)
  const subscriptions = yield* Effect.forEach(
    stopped,
    Effect.fnUntraced(function* (watch) {
      return {
        name: watch.subscribedName,
        arguments: yield* decodeArguments(watch.arguments),
        url: watch.callbackUrl,
      } satisfies Subscription
    }),
  )
  return { retained: history.length > 0, subscriptions }
})

/** Local removal is authoritative even when unsubscribe fails; signed deliveries now answer 410. */
export const unsubscribeWatches = Effect.fn('WatchedApps.unsubscribeWatches')(function* (
  subscriptions: ReadonlyArray<Subscription>,
) {
  if (subscriptions.length === 0) return
  const executor = yield* Executor
  yield* Effect.forEach(
    subscriptions,
    (subscription) =>
      executor.unsubscribeEvent(subscription).pipe(
        Effect.tapError((failure) =>
          Effect.logWarning('Watch unsubscribe did not reach Executor', failure._tag),
        ),
        Effect.ignore,
      ),
    { discard: true },
  )
})
