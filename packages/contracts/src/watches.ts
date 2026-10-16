import { Schema } from 'effect'

/**
 * Watches: something that happens in an Integration wakes Vivid.
 *
 * An Executor app declares events and emits them from its mutations, webhook handlers and
 * workflows. A Watch is Vivid subscribing to one of those events for one Person, with the filter
 * values that narrow it and the instruction of what to do when it fires. Each occurrence wakes
 * Vivid in a background Thread of its own; what needs the Person reaches them through the Feed.
 *
 * Executor's side is `events/list`, `events/subscribe` and `events/unsubscribe` over MCP
 * (executor@2.0.0-beta.23 `packages/mcp/src/implementation/events.ts` `eventsHandler`).
 */

/** A Watch's identifier. It stays on the server and in the callback address; the model never sees it. */
export const WatchId = Schema.String.pipe(Schema.brand('WatchId'))
export type WatchId = typeof WatchId.Type

/**
 * One filter value. Executor declares filters as scalars and matches an occurrence when every
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

/**
 * Where a Watch is in its life. `Pending`: subscribed but not yet confirmed (Executor is verifying
 * the callback, or its answer was lost); the renewal pass finishes it with the same subscription. `Active` holds the time its subscription must be renewed before,
 * in epoch milliseconds (Executor's `refreshBefore` is the subscription's actual expiry).
 */
export const WatchState = Schema.TaggedUnion({
  Pending: {},
  Active: { refreshBefore: Schema.Finite },
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
})
export interface CreateWatchRequest extends Schema.Schema.Type<typeof CreateWatchRequest> {}

/** Stopping a Watch by the name it was given; names are unique among a Person's live Watches. */
export const StopWatchRequest = Schema.Struct({ name: WatchName })
export interface StopWatchRequest extends Schema.Schema.Type<typeof StopWatchRequest> {}

export const WatchResponse = Schema.Struct({ watch: Watch })
export interface WatchResponse extends Schema.Schema.Type<typeof WatchResponse> {}

/** A Person's live Watches: Pending and Active. Stopped Watches are history and are not listed. */
export const WatchListResponse = Schema.Struct({ watches: Schema.Array(Watch) })
export interface WatchListResponse extends Schema.Schema.Type<typeof WatchListResponse> {}
