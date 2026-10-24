import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type { Actor } from '../auth/access.ts'
import {
  ExecutorAppOwnership,
  ExecutorReferences,
  type ExecutorAppId,
} from '../connections/executor.ts'
import { listRecords, type ConnectionRecord } from '../connections/records.ts'
import { namedAccounts } from '../connections/names.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { ExecutorEventsUnreachable, executorSettings, type ExecutorSettings } from './events.ts'

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
  readonly account: string
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

/** Bounds one Executor app-record exchange with no stalled-response signal. Source: unmeasured.
 * Expiry returns ExecutorEventsUnreachable; it does not end a Watch subscription. */
const APP_TIMEOUT = '30 seconds'

/** Only the slug of Executor's app record is read; every other field stays Executor's business. */
const AppRecord = Schema.Struct({ slug: Schema.NonEmptyString })
const decodeApp = Schema.decodeUnknownEffect(AppRecord)

/** Build over the database, an HTTP client and Executor's settings. */
export const makeWatchedApps = (
  database: Database['Service'],
  transport: HttpClient.HttpClient,
  config: ExecutorSettings,
) => {
  const client = HttpClient.withScope(transport)
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

  /** GET the app by id under the configured organization, as the Connection adapter addresses it. */
  const slugOf = Effect.fn('WatchedApps.slugOf')(
    function* (app: string) {
      const request = HttpClientRequest.get(
        `${config.url}/api/organizations/${encodeURIComponent(config.organization)}/apps/${encodeURIComponent(app)}`,
      ).pipe(HttpClientRequest.bearerToken(config.key), HttpClientRequest.acceptJson)
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
      if (response.status < 200 || response.status >= 300)
        return yield* new ExecutorEventsUnreachable({})
      const body = yield* response.json.pipe(
        Effect.mapError(() => new ExecutorEventsUnreachable({})),
      )
      const record = yield* decodeApp(body).pipe(
        Effect.mapError(() => new ExecutorEventsUnreachable({})),
      )
      return record.slug
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: APP_TIMEOUT,
      orElse: () => Effect.fail(new ExecutorEventsUnreachable({})),
    }),
  )

  return WatchedApps.of({
    /** Account names compare as the Connection tools compare them: trimmed, case-insensitive. */
    appOf: Effect.fn('WatchedApps.appOf')(function* (actor, account) {
      const wanted = account.trim().toLowerCase()
      const found = (yield* accounts(actor)).find((item) => item.account.toLowerCase() === wanted)
      if (found === undefined) return yield* new WatchAccountUnknown({})
      const app = yield* Effect.fromResult(dedicatedApp(found.row))
      return { account: found.account, appSlug: yield* slugOf(app) }
    }),
    accountsOf: Effect.fn('WatchedApps.accountsOf')(function* (actor) {
      return (yield* accounts(actor)).flatMap((item) =>
        Result.isSuccess(dedicatedApp(item.row)) ? [item.account] : [],
      )
    }),
  })
}

/** Requires Database and HttpClient; reads the same three Executor settings as the events client. */
export const watchedAppsLayer = Layer.effect(
  WatchedApps,
  Effect.gen(function* () {
    return makeWatchedApps(yield* Database, yield* HttpClient.HttpClient, yield* executorSettings())
  }),
)
