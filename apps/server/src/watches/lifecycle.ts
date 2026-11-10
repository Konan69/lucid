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
  WatchId,
  Watch,
  WatchState,
  type CreateWatchRequest,
  type ReviseWatchFilters,
  type WatchStopReason,
  Incident,
} from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { Changes, Topic } from '../live/changes.ts'
import { FailureAttribute, observeFailures } from '../observability/failure.ts'
import { Message } from '../observability/messages.ts'
import { causeOf, hop, Incidents, incidentsLayer } from '../observability/incidents.ts'
import { untraced } from '../observability/quiet.ts'
import { WatchedApps, WatchConnectionRemoved } from './apps.ts'
import { ExecutorEvents, type EventDefinition, type ExecutorEventsFailure } from './events.ts'
import type { ExecutorCaller } from '../connections/executor.ts'
import { secretFor } from './signature.ts'
import { WatchStore, subscriptionOf, type WatchRecord } from './store.ts'
import { watchProgress, WatchMissing } from './progress.ts'

import { watchCheckins } from './checkins.ts'
import { owedStoreLayer } from '../owed/store.ts'

/**
 * Starting, stopping and keeping Watches alive at Executor.
 *
 * A subscription lives at most seven days at Executor and must be renewed before its
 * `refreshBefore` by subscribing again with the same key; renewal extends it from the request time
 * (executor@2.0.0-beta.23 `packages/sdk/src/contracts/events.ts` `defaultEventDeliveryLimits`,
 * `packages/sdk/src/implementation/events.ts` subscribe). Vivid asks for the longest lifetime and
 * renews each Watch once it is within six hours of expiry.
 */

/** Subscribe or renew one Watch at Executor, as the caller that owns its app. */
export type Subscribe = (
  caller: ExecutorCaller,
  record: WatchRecord,
) => ReturnType<ExecutorEvents['Service']['subscribe']>

/** The lifetime asked for: Executor's maximum. */
export const TTL_MS = 7 * 24 * 60 * 60_000
/** Source: outage-tolerance policy. Six hours leaves thirty-six ten-minute recovery opportunities
 * before provider expiry. This margin schedules renewal and never caps active Watch work. */
export const RENEW_WITHIN_MS = 6 * 60 * 60_000

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
const eventsOfApp = (definitions: ReadonlyArray<EventDefinition>, slug: string) =>
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

/**
 * What a failed renewal or recovery does to its Watch: stop it for a reason, or try again on the
 * next pass. Executor down, the callback not verifying or events off are transient whether or not
 * the subscription has expired meanwhile: subscribing again with the same key creates it afresh
 * once Executor answers (executor@2.0.0-beta.23 `packages/sdk/src/implementation/events.ts`
 * subscribe), so an outage that outlasts the subscription costs the events of the outage and not
 * the Watch. An expired Watch stays Active with its past `refreshBefore`, which says it has lapsed.
 */
const renewalOutcome = (failure: ExecutorEventsFailure): Option.Option<WatchStopReason> => {
  const stop = (reason: WatchStopReason) => () => Option.some(reason)
  const again = () => Option.none<WatchStopReason>()
  return Match.valueTags(failure, {
    ExecutorEventChanged: stop('changed'),
    ExecutorEventMissing: stop('changed'),
    ExecutorEventArgumentsInvalid: stop('changed'),
    ExecutorEventRefused: stop('refused'),
    ExecutorCallbackFailed: again,
    ExecutorEventsUnsupported: again,
    ExecutorEventsUnreachable: again,
  })
}

/**
 * Whether a failed first subscribe may have created the subscription anyway. Only an answer
 * Vivid could not read leaves that open (Executor down, the call timed out, a body it could not
 * decode): the subscription may exist and deliver. Every other failure is Executor's own answer
 * that it did not subscribe.
 */
const outcomeUnknown = (failure: ExecutorEventsFailure) =>
  Match.valueTags(failure, {
    ExecutorEventChanged: () => false,
    ExecutorEventMissing: () => false,
    ExecutorEventArgumentsInvalid: () => false,
    ExecutorEventRefused: () => false,
    ExecutorCallbackFailed: () => false,
    ExecutorEventsUnsupported: () => false,
    ExecutorEventsUnreachable: () => true,
  })

/**
 * How long a Watch may stay Pending before the renewal pass takes it over: twice the longest a
 * subscribe call may take (`CALL_TIMEOUT` in `events.ts`), so a pass does not race a creation
 * that is still waiting on Executor. A Pending row older than this was left by a creation that
 * was interrupted, died with its process, or failed between Executor's grant and activation.
 */
export const RECOVER_AFTER_MS = 60_000

/** An unsubscribe that did not reach Executor: the Watch is already stopped for the Person. */
const unsubscribeFailed = (failure: { readonly _tag: string }) =>
  Effect.logWarning(Message.watchUnsubscribed).pipe(
    Effect.annotateLogs(FailureAttribute.type, failure._tag),
  )

/** A revision owns its grant and compare-and-set; the ordinary lifecycle keeps its original key. */
function makeRevision(input: {
  readonly store: WatchStore['Service']
  readonly events: ExecutorEvents['Service']
  readonly publish: (record: WatchRecord) => Effect.Effect<void>
  readonly subscribe: Subscribe
  readonly callerOf: WatchedApps['Service']['callerOf']
  readonly base: string
}) {
  const { store, events, publish, subscribe, callerOf, base } = input
  /** Grant the revised filters before committing; a failed grant leaves the saved Watch intact.
   * A fresh callback rejects deliveries from the old subscription even if unsubscribe is lost. */
  const revise = Effect.fn('Watches.revise')(function* (actor: Actor, request: ReviseWatchFilters) {
    const found = yield* store.named(actor, request.name)
    if (Option.isNone(found)) return yield* new WatchMissing({})
    const previous = found.value
    const callbackUrl = `${base}/api/watches/${previous.watch.id}?revision=${NodeCrypto.randomUUID()}`
    const proposed = {
      ...previous,
      callbackUrl,
      watch: { ...previous.watch, arguments: request.arguments },
    }
    const caller = yield* callerOf(previous.connectionId)
    const grant = yield* subscribe(caller, proposed)
    const revised = yield* store.revise(
      previous,
      request,
      callbackUrl,
      grant.refreshBefore.getTime(),
    )
    if (Option.isNone(revised)) return yield* new WatchMissing({})
    yield* events
      .unsubscribe(caller, {
        name: previous.subscribedName,
        arguments: previous.watch.arguments,
        url: previous.callbackUrl,
      })
      .pipe(Effect.tapError(unsubscribeFailed), Effect.ignore)
    yield* publish(revised.value)
    return (yield* store.present(actor, revised.value)).watch
  })

  return revise
}

/** The events an account's app declares, read with its owner's credential. */
function findEvents(apps: WatchedApps['Service'], events: ExecutorEvents['Service']) {
  return Effect.fn('Watches.find')(function* (actor: Actor, account: string) {
    const app = yield* apps.appOf(actor, account)
    return eventsOfApp(yield* events.list(app.caller), app.appSlug)
  })
}

/**
 * A Watch Executor says can never be subscribed, so it can no longer wake Vivid. Recorded once:
 * only by the renewal whose stop changed the row.
 */
const stoppedForGood = (record: WatchRecord, failure: { readonly _tag: string }) =>
  Incident.cases.WatchFailed.make({
    personId: record.personId,
    watchId: record.watch.id,
    cause: causeOf(hop('executor', 'Watches.renewOne', failure._tag)),
  })

/**
 * The renewal pass runs untraced (`watchRenewalLayer`); a Watch that is due is work, so each
 * renewal is a trace of its own and an Incident it records has a trace to open.
 */
const ownTrace = <A, E, R>(renewal: Effect.Effect<A, E, R>) =>
  renewal.pipe(Effect.withSpan('Watches.renewDue', { root: true }), Effect.withTracerEnabled(true))

/** Build the service over its stores, Executor and the server's address and secret. */
const make = Effect.fn('Watches.make')(function* () {
  const store = yield* WatchStore
  const incidents = yield* Incidents
  const apps = yield* WatchedApps
  const events = yield* ExecutorEvents
  const changes = yield* Changes
  const config = yield* ServerConfig
  const base = config.PUBLIC_URL.href.replace(/\/$/u, '')

  /** Say a Person's Watches moved, so an open list reloads. */
  const publish = (record: WatchRecord) => changes.publish([Topic.person(record.personId)])

  /** The exact key Executor knows this Watch's subscription by, and the secret it signs with. */

  const subscribe: Subscribe = (caller, record) =>
    events.subscribe(caller, {
      ...subscriptionOf(record),
      secret: secretFor(config.AUTH_SECRET, record.watch.id),
      ttlMs: TTL_MS,
    })

  const progress = yield* watchProgress(subscribe)
  const checks = yield* watchCheckins()

  /** A concurrent stop stays authoritative; a cascaded row means its Integration was removed. */
  const activate = Effect.fn('Watches.activate')(function* (
    record: WatchRecord,
    grant: { readonly id: string; readonly refreshBefore: Date },
  ) {
    const active = yield* store.activate(record.watch.id, grant.refreshBefore.getTime())
    if (Option.isSome(active)) return active.value
    const current = yield* store.find(record.watch.id)
    return yield* Effect.fromOption(current).pipe(
      Effect.mapError(() => new WatchConnectionRemoved({ connectionId: record.connectionId })),
    )
  })

  /**
   * Resolve the account's app, insert the Watch Pending, then subscribe. The row must exist first:
   * Executor POSTs its signed challenge to the callback before it answers `events/subscribe`, and
   * the receiver answers only for a Watch it knows.
   *
   * Executor's refusal removes the Pending row and is the caller's answer. An answer Vivid could
   * not read leaves the row Pending and returns it ("starting" to the model): the subscription may
   * exist, and the renewal pass subscribes again with the same key until Executor answers. So does
   * a creation interrupted anywhere after the insert, the row being its durable record.
   */
  const create = Effect.fn('Watches.create')(function* (actor: Actor, request: CreateWatchRequest) {
    const app = yield* apps.appOf(actor, request.account)
    const declared = eventsOfApp(yield* events.list(app.caller), app.appSlug)
    if (!declared.some((event) => event.event === request.event))
      return yield* new WatchEventUnknown({ known: declared.map((event) => event.event) })
    const purpose = yield* checks.planCheckin(actor, request.purpose)
    const id = WatchId.make(NodeCrypto.randomUUID())
    const pending = yield* store.insertPending({
      id,
      personId: actor.person.id,
      // Person-owned; the Company is the workspace it was made in, as other Person-owned rows keep.
      companyId: companyColumnOf(actor.workspace),
      name: request.name,
      connectionId: app.connectionId,
      event: request.event,
      subscribedName: `${app.appSlug}.${request.event}`,
      arguments: request.arguments,
      instruction: request.instruction,
      condition: request.condition,
      purpose,
      callbackUrl: `${base}/api/watches/${id}`,
    })
    const granted = yield* Effect.result(subscribe(app.caller, pending))
    if (Result.isFailure(granted)) {
      if (outcomeUnknown(granted.failure)) {
        yield* publish(pending)
        return (yield* store.present(actor, pending)).watch
      }
      yield* store.discard(id)
      return yield* granted.failure
    }
    const active = yield* activate(pending, granted.success)
    yield* publish(active)
    return (yield* store.present(actor, active)).watch
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
    yield* apps.callerOf(found.value.connectionId).pipe(
      Effect.flatMap((caller) => events.unsubscribe(caller, subscriptionOf(found.value))),
      Effect.tapError(unsubscribeFailed),
      Effect.ignore,
    )
    yield* publish(stopped.value)
    return Watch.make({ ...stopped.value.watch, account: found.value.watch.account })
  })

  /**
   * Renew an Active Watch, or finish a Pending one a creation left behind, with the key it was
   * created with: Executor's subscription id is derived from that key, so this is the same
   * subscription whether or not the first attempt reached Executor. Stop it only when Executor
   * says it can never be subscribed; anything else is tried again on the next pass.
   */
  const renewOne = Effect.fn('Watches.renewOne')(function* (record: WatchRecord) {
    const caller = yield* apps.callerOf(record.connectionId)
    const renewed = yield* Effect.result(subscribe(caller, record))
    if (Result.isSuccess(renewed)) {
      if (WatchState.guards.Paused(record.watch.state)) {
        yield* store.renewPaused(record.watch.id, renewed.success.refreshBefore.getTime())
        return
      }
      const active = yield* activate(record, renewed.success)
      if (WatchState.guards.Pending(record.watch.state)) yield* publish(active)
      return
    }
    const reason = renewalOutcome(renewed.failure)
    if (Option.isNone(reason)) return
    const stopped = yield* store.stop(record.watch.id, reason.value)
    if (Option.isSome(stopped)) yield* incidents.record(stoppedForGood(record, renewed.failure))
    yield* publish(record)
  })

  /**
   * One pass over every Watch due: Active ones near or past expiry and Pending ones left behind.
   * One Watch's failure does not hold up the others.
   */
  const renew = Effect.fn('Watches.renew')(function* () {
    yield* progress.reconcile()
    const now = yield* Clock.currentTimeMillis
    const due = yield* store.due({
      activeBefore: now + RENEW_WITHIN_MS,
      pendingBefore: now - RECOVER_AFTER_MS,
    })
    const outcomes = yield* Effect.forEach(due, (record) => Effect.exit(ownTrace(renewOne(record))))
    for (const outcome of outcomes) yield* outcome
  })

  return {
    create,
    ...checks,
    revise: makeRevision({ store, events, publish, subscribe, callerOf: apps.callerOf, base }),
    find: findEvents(apps, events),
    stop,
    complete: progress.complete,
    connectionChanged: progress.connectionChanged,
    pauseCurrent: progress.pauseCurrent,
    list: (actor: Actor) =>
      store.list(actor).pipe(Effect.map((all) => all.map((one) => one.watch))),
    renew,
  }
})

export class Watches extends Context.Service<Watches, Effect.Success<ReturnType<typeof make>>>()(
  'vivid/Watches',
) {}

export const watchesLayer = Layer.effect(Watches, make()).pipe(
  Layer.provide([owedStoreLayer, incidentsLayer]),
)

/**
 * The renewal worker: one pass every ten minutes, scoped to the server, with no detached timer.
 * Six hours of margin is thirty-six passes, so an Executor outage shorter than that loses nothing.
 */
export const watchRenewalLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const watching = yield* Watches
    const pass = watching.renew().pipe(observeFailures('schedule'), Effect.ignore)
    yield* pass.pipe(untraced, Effect.repeat(Schedule.spaced('10 minutes')), Effect.forkScoped)
  }),
)
