import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type { Actor } from '../auth/access.ts'
import { listRecords } from '../connections/records.ts'
import { namedAccounts } from '../connections/names.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { ExecutorEventsUnreachable, executorSettings, type ExecutorSettings } from './events.ts'

/**
 * Which Executor app an Integration account runs on, by the name the Person was shown.
 *
 * Executor names events `<app slug>.<declared name>`, while a Connection stores its app's
 * immutable id (`ExecutorReferences.app` in `connections/executor.ts`). The slug is read from
 * Executor's app record (`AppFields.slug`, executor@2.0.0-beta.23
 * `packages/sdk/src/contracts/apps.ts`), because a rename changes it and nothing in Vivid stores it.
 *
 * This reads the current Connection store and nothing else of it. It is the one place Watches
 * depend on how Connections are stored, so the Executor beta.23 Connection rewrite rewires only
 * this file.
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

/** An account and the slug of the app it runs on. */
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
    | ExecutorEventsUnreachable
    | DatabaseInfrastructureError
  >
  /** The names of the Actor's ready accounts, to say which ones exist when a name matches none. */
  readonly accountsOf: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<string>, DatabaseInfrastructureError>
}

export class WatchedApps extends Context.Service<WatchedApps, WatchedAppsService>()(
  'vivid/WatchedApps',
) {}

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
  const accounts = (actor: Actor) =>
    listRecords(actor).pipe(Effect.map(namedAccounts), Effect.provideService(Database, database))

  /** GET the app by id under the configured organization, as the Connection adapter addresses it. */
  const slugOf = Effect.fn('WatchedApps.slugOf')(function* (app: string) {
    const request = HttpClientRequest.get(
      `${config.url}/api/organizations/${encodeURIComponent(config.organization)}/apps/${encodeURIComponent(app)}`,
    ).pipe(HttpClientRequest.bearerToken(config.key), HttpClientRequest.acceptJson)
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
    if (response.status < 200 || response.status >= 300)
      return yield* new ExecutorEventsUnreachable({})
    const body = yield* response.json.pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
    const record = yield* decodeApp(body).pipe(
      Effect.mapError(() => new ExecutorEventsUnreachable({})),
    )
    return record.slug
  }, Effect.scoped)

  return WatchedApps.of({
    /** Account names compare as the Connection tools compare them: trimmed, case-insensitive. */
    appOf: Effect.fn('WatchedApps.appOf')(function* (actor, account) {
      const wanted = account.trim().toLowerCase()
      const found = (yield* accounts(actor)).find((item) => item.account.toLowerCase() === wanted)
      if (found === undefined) return yield* new WatchAccountUnknown({})
      if (found.row.status !== 'ready') return yield* new WatchAccountNotReady({})
      return { account: found.account, appSlug: yield* slugOf(found.row.references.app) }
    }),
    accountsOf: Effect.fn('WatchedApps.accountsOf')(function* (actor) {
      return (yield* accounts(actor)).flatMap((item) =>
        item.row.status === 'ready' ? [item.account] : [],
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
