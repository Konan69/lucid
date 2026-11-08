import { Schema } from 'effect'
import { ConnectionId, RunId, OwedId, ThreadId, ProjectId, PersonId } from './identity.js'

/**
 * Watches: something that happens in an Integration wakes Vivid.
 *
 * An Executor app declares events and emits them from its mutations, webhook handlers and
 * workflows. A Watch is Vivid subscribing to one of those events for one Person, with the filter
 * values that narrow it and the instruction of what to do when it fires. Each event wakes
 * Vivid in a background Thread of its own; what needs the Person reaches them through the Feed.
 *
 * Executor's side is `events/list`, `events/subscribe` and `events/unsubscribe` over MCP
 * (executor@2.0.0-beta.23 `packages/mcp/src/implementation/events.ts` `eventsHandler`).
 */

/** A Watch's identifier. It stays on the server and in the callback address; the model never sees it. */
export const WatchId = Schema.String.pipe(Schema.brand('WatchId'))
export type WatchId = typeof WatchId.Type

/**
 * One filter value. Executor declares filters as scalars and matches an event when every
 * named value is equal (`EventArguments` in executor@2.0.0-beta.23
 * `packages/sdk/src/contracts/events.ts`); nothing richer is accepted there.
 */
export const WatchFilterValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
export type WatchFilterValue = typeof WatchFilterValue.Type

/** The filter values a Watch narrows its event by, keyed by the declared filter name. */
export const WatchArguments = Schema.Record(Schema.String, WatchFilterValue)
export type WatchArguments = typeof WatchArguments.Type

/** A Person-readable name for a Watch, such as "New mail in Work Gmail". It names the Watch to the model. */
export const WatchName = Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(1, 200))

/** What Vivid should do when the Watch fires, in the Person's words. */
export const WatchInstruction = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, 4000),
)

/**
 * Why a Watch stopped. `removed`: the Person or Vivid stopped it. `refused`: Executor no longer
 * lets this Vivid use the event. `changed`: the app no longer declares the event or a filter it
 * names. An unreachable Executor never stops a Watch: renewal keeps trying, even past expiry.
 */
export const WatchStopReason = Schema.Literals(['removed', 'refused', 'changed'])
export type WatchStopReason = typeof WatchStopReason.Type

/** Continuous work ends only on cancellation; Until needs a real read proving this condition. */
export const WatchCondition = Schema.TaggedUnion({
  Continuous: {},
  Until: { condition: Schema.NonEmptyString },
})
export type WatchCondition = typeof WatchCondition.Type

/** One timer operation is persisted before dispatch and reused after an uncertain call. */
export const TimerOperationKey = Schema.NonEmptyString.pipe(Schema.brand('TimerOperationKey'))
export type TimerOperationKey = typeof TimerOperationKey.Type

/** Project is a typed extension point, awaiting its owning unit's actual state model. */
export const CheckinFocus = Schema.TaggedUnion({
  OpenWork: {},
  Owed: { owedId: OwedId },
  Thread: { threadId: ThreadId },
  Project: { projectId: ProjectId },
})
export type CheckinFocus = typeof CheckinFocus.Type
/** No public command can schedule a Project check-in before its state is available. */
export const AvailableCheckinFocus = Schema.Union([
  CheckinFocus.cases.OpenWork,
  CheckinFocus.cases.Owed,
  CheckinFocus.cases.Thread,
]).pipe(Schema.toTaggedUnion('_tag'))

/** The timer Integration owns execution and recurrence; this records who chose the check. */
export const CheckinTiming = Schema.TaggedUnion({
  Chosen: { nextAt: Schema.Finite, why: Schema.NonEmptyString },
  Requested: { request: Schema.NonEmptyString, timezone: Schema.NonEmptyString },
})
export type CheckinTiming = typeof CheckinTiming.Type

/** Only the actual timer call's decoded receipt may confirm its persisted operation key. */
export const CheckinArming = Schema.TaggedUnion({
  Awaiting: { operationKey: TimerOperationKey },
  Confirmed: { operationKey: TimerOperationKey, nextAt: Schema.Finite },
})
export type CheckinArming = typeof CheckinArming.Type
/** This is decoded from the timer Integration’s actual tool response, not supplied through a confirmation RPC. */
export const TimerReceipt = Schema.Struct({
  operationKey: TimerOperationKey,
  nextAt: Schema.Finite,
})
export interface TimerReceipt extends Schema.Schema.Type<typeof TimerReceipt> {}

const checkin = { focus: AvailableCheckinFocus, timing: CheckinTiming }
/** Callers choose intent; the server creates arming authority. */
export const WatchIntent = Schema.TaggedUnion({ Event: {}, Checkin: checkin })
export type WatchIntent = typeof WatchIntent.Type
/**
 * What the server read of a check-in's open work when its timer fired: the open records, in names
 * and product facts only, or the persisted evidence that the work has ended.
 */
export const CheckinRead = Schema.TaggedUnion({
  Open: { context: Schema.NonEmptyString },
  Closed: { evidence: Schema.NonEmptyString },
})
export type CheckinRead = typeof CheckinRead.Type

/** A timer subscription and a confirmed timer are distinct persisted facts. */
export const WatchPurpose = Schema.TaggedUnion({
  Event: {},
  Checkin: { ...checkin, arming: CheckinArming },
})
export type WatchPurpose = typeof WatchPurpose.Type

/** An Event Watch with the same name is not a live check-in. */
export class CheckinNotFound extends Schema.TaggedError<CheckinNotFound>()(
  'CheckinNotFound',
  {
    personId: PersonId,
    name: WatchName,
    message: Schema.Literal('There is no check-in by that name.'),
  },
  { title: 'Check-in not found' },
) {}
/** The product retains Awaiting when dispatch supplied no matching scheduling receipt. */
export class CheckinNotScheduled extends Schema.TaggedError<CheckinNotScheduled>()(
  'CheckinNotScheduled',
  {
    watchId: WatchId,
    operationKey: TimerOperationKey,
    message: Schema.Literal('The check-in was not scheduled; nothing will wake Vivid for it yet.'),
  },
  { title: 'Check-in not scheduled' },
) {}

/**
 * Where a Watch is in its life. `Pending`: subscribed but not yet confirmed (Executor is verifying
 * the callback, or its answer was lost); the renewal pass finishes it with the same subscription. `Active` holds the time its subscription must be renewed before,
 * in epoch milliseconds (Executor's `refreshBefore` is the subscription's actual expiry).
 */
export const WatchState = Schema.TaggedUnion({
  Pending: {},
  Active: { refreshBefore: Schema.Finite },
  Paused: { at: Schema.Finite, connectionId: ConnectionId },
  Completed: { at: Schema.Finite, runId: RunId, evidence: Schema.NonEmptyString },
  Stopped: { reason: WatchStopReason },
})
export type WatchState = typeof WatchState.Type

/** A Watch as its owner and Vivid read it. */
export const Watch = Schema.Struct({
  id: WatchId,
  name: WatchName,
  /** The Integration's account name as the Person sees it, such as "Gmail (Work)". */
  account: Schema.String,
  /** The event's declared name within its app, such as `message.received`. */
  event: Schema.String,
  arguments: WatchArguments,
  instruction: WatchInstruction,
  condition: WatchCondition,
  purpose: WatchPurpose,
  state: WatchState,
  createdAt: Schema.Finite,
}).annotate({ identifier: 'Watch', title: 'Watch' })
export interface Watch extends Schema.Schema.Type<typeof Watch> {}

/** One filter an event declares, with its JSON type, so Vivid can offer values that fit. */
export const AppEventFilter = Schema.Struct({ name: Schema.String, type: Schema.String })
export interface AppEventFilter extends Schema.Schema.Type<typeof AppEventFilter> {}

/** One event an Integration's app declares, as Vivid is shown it: words only, no app slug. */
export const AppEvent = Schema.Struct({
  event: Schema.String,
  description: Schema.String,
  filters: Schema.Array(AppEventFilter),
})
export interface AppEvent extends Schema.Schema.Type<typeof AppEvent> {}

/** Asking which events an account's app declares, by the account name the Person was shown. */
export const FindAppEventsRequest = Schema.Struct({ account: Schema.String })
export interface FindAppEventsRequest extends Schema.Schema.Type<typeof FindAppEventsRequest> {}
export const FindAppEventsResponse = Schema.Struct({ events: Schema.Array(AppEvent) })
export interface FindAppEventsResponse extends Schema.Schema.Type<typeof FindAppEventsResponse> {}

/** Starting a Watch. The server resolves the account to its Integration and the app's event. */
export const CreateWatchRequest = Schema.Struct({
  name: WatchName,
  account: Schema.String,
  event: Schema.String,
  arguments: WatchArguments,
  instruction: WatchInstruction,
  condition: WatchCondition,
  purpose: WatchIntent,
})
export interface CreateWatchRequest extends Schema.Schema.Type<typeof CreateWatchRequest> {}

/** Stopping a Watch by the name it was given; names are unique among a Person's live Watches. */
export const StopWatchRequest = Schema.Struct({ name: WatchName })
export interface StopWatchRequest extends Schema.Schema.Type<typeof StopWatchRequest> {}

/** The admitted Watch Run supplies completion authority; model input supplies evidence only. */
export const CompleteWatchRequest = Schema.Struct({
  name: WatchName,
  evidence: Schema.NonEmptyString,
})
export interface CompleteWatchRequest extends Schema.Schema.Type<typeof CompleteWatchRequest> {}

/** Only server admission establishes which Watch the current Run may finish. */
export class WatchRunRequired extends Schema.TaggedError<WatchRunRequired>()(
  'WatchRunRequired',
  {
    watchId: WatchId,
    message: Schema.Literal('Only the run this watch started can finish it.'),
  },
  { title: 'Watch Run required' },
) {}

/** A continuous Watch has no condition whose evidence could complete it. */
export class WatchEndConditionRequired extends Schema.TaggedError<WatchEndConditionRequired>()(
  'WatchEndConditionRequired',
  {
    watchId: WatchId,
    message: Schema.Literal(
      'This watch has no end condition, so it keeps watching until it is stopped.',
    ),
  },
  { title: 'Watch end condition required' },
) {}

export const WatchResponse = Schema.Struct({ watch: Watch })
export interface WatchResponse extends Schema.Schema.Type<typeof WatchResponse> {}

/** Pending, Active and Paused Watches; Stopped and Completed records remain terminal history. */
export const WatchListResponse = Schema.Struct({ watches: Schema.Array(Watch) })
export interface WatchListResponse extends Schema.Schema.Type<typeof WatchListResponse> {}

/**
 * Revise a live Watch in place, keeping its identity. `Filters`: replace its complete filters and
 * instruction. `Timing`: choose a check-in's next time, keeping what it follows; the old timer is
 * disarmed until a fresh receipt confirms the new one (`watches/checkins.ts`).
 */
export const ReviseWatchRequest = Schema.TaggedUnion({
  Filters: { name: WatchName, arguments: WatchArguments, instruction: WatchInstruction },
  Timing: { name: WatchName, timing: CheckinTiming },
})
export type ReviseWatchRequest = typeof ReviseWatchRequest.Type
export type ReviseWatchFilters = typeof ReviseWatchRequest.cases.Filters.Type
export type ReviseCheckinTiming = typeof ReviseWatchRequest.cases.Timing.Type
