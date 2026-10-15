import * as NodeCrypto from 'node:crypto'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import {
  AppEvent,
  AppEventFilter,
  DatabaseFailure,
  WatchId,
  WatchState,
  type CreateWatchRequest,
  type WatchStopReason,
} from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { Changes, Topic } from '../live/changes.ts'
import { observeFailures } from '../observability/failure.ts'
import { untraced } from '../observability/quiet.ts'
import { WatchedApps } from './apps.ts'
import { ExecutorEvents, type EventDefinition, type ExecutorEventsFailure } from './events.ts'
import { secretFor } from './signature.ts'
import { WatchStore, type WatchRecord } from './store.ts'

/**
 * Starting, stopping and keeping Watches alive at Executor.
 *
 * A subscription lives at most seven days at Executor and must be renewed before its
 * `refreshBefore` by subscribing again with the same key; renewal extends it from the request time
 * (executor@2.0.0-beta.23 `packages/sdk/src/contracts/events.ts` `defaultEventDeliveryLimits`,
 * `packages/sdk/src/implementation/events.ts` subscribe). Vivid asks for the longest lifetime and
 * renews each Watch once it is within six hours of expiry.
 */

/** The lifetime asked for: Executor's maximum. */
export const TTL_MS = 7 * 24 * 60 * 60_000
/** A Watch is renewed once its subscription expires within this. */
export const RENEW_WITHIN_MS = 6 * 60 * 60_000

/** The Actor has no live Watch by this name. */
export class WatchMissing extends Schema.TaggedError<WatchMissing>()(
  'WatchMissing',
  {},
  { title: 'Watch missing' },
) {}
/** The account's app declares no event by this name. */
export class WatchEventUnknown extends Schema.TaggedError<WatchEventUnknown>()(
  'WatchEventUnknown',
  { known: Schema.Array(Schema.String) },
  { title: 'Watch event unknown' },
) {}

/**
 * The filters an event declares, read from its input schema's properties. A filter is a scalar
 * or a literal (`event()` in executor `packages/app-templates/executor/skills/app-authoring/
 * events.md`); its JSON type is what Vivid needs to offer a value, and a literal says its value.
 */
const FilterProperty = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  const: Schema.optionalKey(Schema.Json),
})
const decodeFilter = Schema.decodeUnknownOption(FilterProperty)
const filtersOf = (definition: EventDefinition) => {
  const properties = definition.inputSchema.properties
  if (properties === undefined) return []
  return Object.entries(properties).map(([name, property]) => {
    const read = decodeFilter(property)
    const type = Option.match(read, {
      onNone: () => 'value',
      onSome: (filter) =>
        filter.const !== undefined
          ? `exactly ${JSON.stringify(filter.const)}`
          : Option.getOrElse(Option.fromUndefinedOr(filter.type), () => 'value'),
    })
    return AppEventFilter.make({ name, type })
  })
}

/** The events of one app, named without the app's slug, as Vivid is shown them. */
export const eventsOfApp = (definitions: ReadonlyArray<EventDefinition>, slug: string) =>
  definitions.flatMap((definition) =>
    definition.name.startsWith(`${slug}.`)
      ? [
          AppEvent.make({
            event: definition.name.slice(slug.length + 1),
            description: definition.description,
            filters: filtersOf(definition),
          }),
        ]
      : [],
  )

/** What a failed renewal does to its Watch: stop it for a reason, or try again on the next pass. */
export const renewalOutcome = (
  failure: ExecutorEventsFailure,
  expired: boolean,
): Option.Option<WatchStopReason> => {
  const stop = (reason: WatchStopReason) => () => Option.some(reason)
  // Executor down, the callback not verifying or events off: transient while the subscription
  // lives, and the Watch has lapsed once it has expired.
  const transient = () => (expired ? Option.some<WatchStopReason>('unreachable') : Option.none())
  return Match.valueTags(failure, {
    ExecutorEventChanged: stop('changed'),
    ExecutorEventMissing: stop('changed'),
    ExecutorEventArgumentsInvalid: stop('changed'),
    ExecutorEventRefused: stop('refused'),
    ExecutorCallbackFailed: transient,
    ExecutorEventsUnsupported: transient,
    ExecutorEventsUnreachable: transient,
  })
}

/** Build the service over its stores, Executor and the server's address and secret. */
const make = Effect.fn('Watches.make')(function* () {
  const store = yield* WatchStore
  const apps = yield* WatchedApps
  const events = yield* ExecutorEvents
  const changes = yield* Changes
  const config = yield* ServerConfig
  const base = config.PUBLIC_URL.href.replace(/\/$/u, '')

  /** Say a Person's Watches moved, so an open list reloads. */
  const publish = (record: WatchRecord) => changes.publish([Topic.person(record.personId)])

  /** The exact key Executor knows this Watch's subscription by, and the secret it signs with. */
  const keyOf = (record: WatchRecord) => ({
    name: record.subscribedName,
    arguments: record.watch.arguments,
    url: record.callbackUrl,
  })
  const subscribe = (record: WatchRecord) =>
    events.subscribe({
      ...keyOf(record),
      secret: secretFor(config.AUTH_SECRET, record.watch.id),
      ttlMs: TTL_MS,
    })

  /** Executor's grant becomes the Watch's Active state. A row that vanished is a database fault. */
  const activate = Effect.fn('Watches.activate')(function* (
    record: WatchRecord,
    grant: { readonly id: string; readonly refreshBefore: Date },
  ) {
    const active = yield* store.activate(record.watch.id, {
      subscription: grant.id,
      refreshBefore: grant.refreshBefore.getTime(),
    })
    return yield* Effect.fromOption(active).pipe(
      Effect.mapError(() => new DatabaseFailure({ message: 'A subscribed Watch was not live' })),
    )
  })

  /**
   * Resolve the account's app, insert the Watch Pending, then subscribe. The row must exist first:
   * Executor POSTs its signed challenge to the callback before it answers `events/subscribe`, and
   * the receiver answers only for a Watch it knows. A refusal removes the Pending row.
   */
  const create = Effect.fn('Watches.create')(function* (actor: Actor, request: CreateWatchRequest) {
    const app = yield* apps.appOf(actor, request.account)
    const declared = eventsOfApp(yield* events.list, app.appSlug)
    if (!declared.some((event) => event.event === request.event))
      return yield* new WatchEventUnknown({ known: declared.map((event) => event.event) })
    const id = WatchId.make(NodeCrypto.randomUUID())
    const pending = yield* store.insertPending({
      id,
      personId: actor.person.id,
      // Person-owned; the Company is the workspace it was made in, as other Person-owned rows keep.
      companyId: companyColumnOf(actor.workspace),
      name: request.name,
      account: app.account,
      event: request.event,
      subscribedName: `${app.appSlug}.${request.event}`,
      arguments: request.arguments,
      instruction: request.instruction,
      callbackUrl: `${base}/api/watches/${id}`,
    })
    const grant = yield* subscribe(pending).pipe(Effect.tapError(() => store.discard(id)))
    const active = yield* activate(pending, grant)
    yield* publish(active)
    return active.watch
  })

  /** The events an account's app declares, in words. */
  const find = Effect.fn('Watches.find')(function* (actor: Actor, account: string) {
    const app = yield* apps.appOf(actor, account)
    return eventsOfApp(yield* events.list, app.appSlug)
  })

  /**
   * Stop a Watch by name. It stops for the Person first, whatever Executor then says: an
   * unsubscribe that does not get through leaves a subscription that expires within its lifetime,
   * and its deliveries meanwhile are answered Gone (`receiver.ts`).
   */
  const stop = Effect.fn('Watches.stop')(function* (actor: Actor, name: string) {
    const found = yield* store.named(actor, name)
    if (Option.isNone(found)) return yield* new WatchMissing({})
    const stopped = yield* store.stop(found.value.watch.id, 'removed')
    if (Option.isNone(stopped)) return yield* new WatchMissing({})
    yield* events.unsubscribe(keyOf(found.value)).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning('Watch unsubscribe did not reach Executor', failure._tag),
      ),
      Effect.ignore,
    )
    yield* publish(stopped.value)
    return stopped.value.watch
  })

  /** Renew one Watch, or stop it when Executor says it can never be renewed. */
  const renewOne = Effect.fn('Watches.renewOne')(function* (record: WatchRecord, now: number) {
    const expired = WatchState.match(record.watch.state, {
      Active: ({ refreshBefore }) => refreshBefore <= now,
      Pending: () => false,
      Stopped: () => false,
    })
    const renewed = yield* Effect.result(subscribe(record))
    if (Result.isSuccess(renewed)) {
      yield* activate(record, renewed.success)
      return
    }
    const reason = renewalOutcome(renewed.failure, expired)
    if (Option.isNone(reason)) return
    yield* store.stop(record.watch.id, reason.value)
    yield* publish(record)
  })

  /** One pass over every Watch due for renewal. One Watch's failure does not hold up the others. */
  const renew = Effect.fn('Watches.renew')(function* () {
    const now = yield* Clock.currentTimeMillis
    const due = yield* store.renewable(now + RENEW_WITHIN_MS)
    const outcomes = yield* Effect.forEach(due, (record) => Effect.exit(renewOne(record, now)))
    for (const outcome of outcomes) yield* outcome
  })

  return {
    create,
    find,
    stop,
    list: (actor: Actor) =>
      store.list(actor).pipe(Effect.map((all) => all.map((one) => one.watch))),
    renew,
  }
})

export class Watches extends Context.Service<Watches, Effect.Success<ReturnType<typeof make>>>()(
  'vivid/Watches',
) {}

export const watchesLayer = Layer.effect(Watches, make())

/**
 * The renewal worker: one pass every ten minutes, scoped to the server, with no detached timer.
 * Six hours of margin is thirty-six passes, so an Executor outage shorter than that loses nothing.
 */
export const watchRenewalLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const watching = yield* Watches
    const pass = watching.renew().pipe(
      observeFailures('schedule'),
      Effect.tapError((error) => Effect.logError('Watch renewal pass failed', error)),
      Effect.ignore,
    )
    yield* pass.pipe(untraced, Effect.repeat(Schedule.spaced('10 minutes')), Effect.forkScoped)
  }),
)
