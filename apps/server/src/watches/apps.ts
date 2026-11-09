import { and, eq, notInArray } from 'drizzle-orm'
import { ConnectionId, WatchArguments } from '@vivid/contracts'
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
import { listRecords, type ConnectionRecord } from '../connections/records.ts'
import { namedAccounts } from '../connections/names.ts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { ExecutorEvents, ExecutorEventsUnreachable, type Subscription } from './events.ts'
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

/** The Connection was removed after resolution or while Executor was granting the subscription. */
export class WatchConnectionRemoved extends Schema.TaggedError<WatchConnectionRemoved>()(
  'WatchConnectionRemoved',
  { connectionId: ConnectionId },
  { title: 'Watch Integration removed' },
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
  /** Read persisted authorization, without treating a provider outage as expired sign-in. */
  readonly needsAuthorization: (
    id: ConnectionId,
  ) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly isReady: (id: ConnectionId) => Effect.Effect<boolean, DatabaseInfrastructureError>
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
    needsAuthorization: (id) =>
      database
        .run(
          database
            .select({ status: connections.status })
            .from(connections)
            .where(eq(connections.id, id)),
        )
        .pipe(Effect.map((rows) => rows.some((row) => row.status === 'needs-authorization'))),
    isReady: (id) =>
      database
        .run(
          database
            .select({ status: connections.status })
            .from(connections)
            .where(eq(connections.id, id)),
        )
        .pipe(Effect.map((rows) => rows.some((row) => row.status === 'ready'))),
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

export const watchedAppsLayer = Layer.effect(
  WatchedApps,
  Effect.gen(function* () {
    return makeWatchedApps(yield* Database, yield* Executor)
  }),
)

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/** Creation and removal lock the same identity, so a stale account resolution cannot revive it. */
export const holdConnection = Effect.fn('WatchedApps.holdConnection')(function* (
  tx: Transaction,
  id: ConnectionId,
) {
  const rows = yield* tx
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(eq(connections.id, id))
    .for('update')
  const [connection] = rows
  if (connection === undefined) return yield* new WatchConnectionRemoved({ connectionId: id })
  return connection.status
})

/** Display names depend on the whole inventory, so name it once per owner-facing read. */
export const accountNames = Effect.fn('WatchedApps.accountNames')(function* (actor: Actor) {
  return new Map(
    namedAccounts(yield* listRecords(actor)).map((item) => [item.row.id, item.account]),
  )
})

const decodeArguments = decodeStored(WatchArguments, 'Watch arguments')

/** Capture live subscription keys before Connection deletion cascades to the Watch rows. */
export const disconnectWatches = Effect.fn('WatchedApps.disconnectWatches')(function* (
  tx: Transaction,
  id: ConnectionId,
) {
  const live = yield* tx
    .select()
    .from(watches)
    .where(and(eq(watches.connectionId, id), notInArray(watches.state, ['Stopped', 'Completed'])))
  const subscriptions = yield* Effect.forEach(
    live,
    Effect.fnUntraced(function* (watch) {
      return {
        name: watch.subscribedName,
        arguments: yield* decodeArguments(watch.arguments),
        url: watch.callbackUrl,
      } satisfies Subscription
    }),
  )
  return subscriptions
})

/** Local removal is authoritative even when unsubscribe fails; signed deliveries now answer 410. */
export const unsubscribeWatches = Effect.fn('WatchedApps.unsubscribeWatches')(function* (
  subscriptions: ReadonlyArray<Subscription>,
) {
  if (subscriptions.length === 0) return
  const events = yield* ExecutorEvents
  yield* Effect.forEach(
    subscriptions,
    (subscription) =>
      events.unsubscribe(subscription).pipe(
        Effect.tapError((failure) =>
          Effect.logWarning('Watch unsubscribe did not reach Executor', failure._tag),
        ),
        Effect.ignore,
      ),
    { discard: true },
  )
})
