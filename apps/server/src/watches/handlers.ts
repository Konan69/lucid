import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Schema from 'effect/Schema'
import {
  Conflict,
  FindAppEventsResponse,
  Forbidden,
  InvalidRequest,
  NotFound,
  type ProjectNotActive,
  ServiceUnavailable,
  WatchListResponse,
  WatchResponse,
  type CreateWatchRequest,
  ReviseWatchRequest,
  type FindAppEventsRequest,
  StopWatchRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import {
  WatchedApps,
  type WatchConnectionRemoved,
  type WatchAccountNotReady,
  type WatchAccountShared,
  type WatchAccountUnknown,
} from './apps.ts'
import { ExecutorEventsFailure } from './events.ts'
import { Watches, type WatchEventUnknown } from './lifecycle.ts'
import type { WatchNameTaken } from './store.ts'

/**
 * The Watch RPCs. Every refusal becomes a fixed RPC failure whose message Vivid can repeat to the
 * Person in words: no Watch id, app slug or Executor detail reaches the model.
 */

const unavailable = (message: string) => new ServiceUnavailable({ service: 'connections', message })

/** Executor's answers, as the model reads them. */
const executorFailure = (failure: ExecutorEventsFailure) => {
  const changed = () =>
    new InvalidRequest({ message: 'This Integration no longer offers that event.' })
  return Match.valueTags(failure, {
    ExecutorEventMissing: changed,
    ExecutorEventChanged: changed,
    ExecutorEventArgumentsInvalid: ({ message }) =>
      new InvalidRequest({
        message: `Those filters do not fit the event: ${message}. Use only the filters find_events lists.`,
      }),
    ExecutorCallbackFailed: () =>
      unavailable('Vivid could not be reached at its own address to receive events.'),
    ExecutorEventRefused: () =>
      new Forbidden({ message: 'This Integration does not let Vivid watch that event.' }),
    ExecutorEventsUnsupported: () =>
      unavailable('Integrations on this Vivid cannot send events yet.'),
    ExecutorEventsUnreachable: () =>
      unavailable('Integrations are not answering right now. Try again shortly.'),
  })
}

/** The names of the Actor's accounts, for a refusal that says which ones exist. */
const accountsText = Effect.fn('Rpc.Watch.accounts')(function* (actor: Actor) {
  const names = yield* (yield* WatchedApps).accountsOf(actor)
  return names.length === 0 ? 'No Integration is connected.' : `Connected: ${names.join(', ')}.`
})

/** Account and Executor failures shared by finding events and creating a Watch. */
const resolved = <A, R>(
  actor: Actor,
  effect: Effect.Effect<
    A,
    | NotFound
    | ProjectNotActive
    | ExecutorEventsFailure
    | WatchAccountUnknown
    | WatchAccountNotReady
    | WatchAccountShared
    | DatabaseInfrastructureError
    | WatchEventUnknown
    | WatchNameTaken
    | WatchConnectionRemoved,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      ProjectNotActive: () =>
        Effect.fail(new InvalidRequest({ message: 'Only an active Project can have a check-in.' })),
      WatchAccountUnknown: () =>
        accountsText(actor).pipe(
          Effect.flatMap((known) =>
            Effect.fail(
              new NotFound({ message: `No Integration account has that name. ${known}` }),
            ),
          ),
        ),
      WatchConnectionRemoved: () =>
        Effect.fail(
          new InvalidRequest({
            message:
              'This Integration was removed while the Watch was starting. Connect it again before watching it.',
          }),
        ),
      WatchAccountNotReady: () =>
        Effect.fail(
          new InvalidRequest({ message: 'Reconnect this Integration before watching it.' }),
        ),
      WatchAccountShared: () =>
        Effect.fail(
          new InvalidRequest({
            message:
              'This Integration still runs on an app it may share with other accounts, so its events cannot be told apart. Remove it and connect it again before watching it.',
          }),
        ),
      WatchEventUnknown: ({ known }) =>
        Effect.fail(
          new InvalidRequest({
            message:
              known.length === 0
                ? 'This Integration has no events to watch.'
                : `That Integration has no such event. Its events: ${known.join(', ')}.`,
          }),
        ),
      WatchNameTaken: () =>
        Effect.fail(
          new Conflict({ message: 'A Watch with that name already exists. Choose another name.' }),
        ),
    }),
    Effect.catchIf(Schema.is(ExecutorEventsFailure), (failure) =>
      Effect.fail(executorFailure(failure)),
    ),
  )

/** List and live subscriptions share the owner-scoped projection. */
const listed = Effect.fn('Rpc.Watches.listed')(function* (actor: Actor) {
  return WatchListResponse.make({ watches: yield* (yield* Watches).list(actor) })
})

export const watchHandlers = {
  /** Events are resolved under the same acting Person and account names as creation. */
  FindAppEvents: Effect.fn('Rpc.FindAppEvents')(function* (request: FindAppEventsRequest) {
    const actor = yield* requireActor()
    const events = yield* resolved(actor, (yield* Watches).find(actor, request.account))
    return FindAppEventsResponse.make({ events })
  }),
  /** A Watch is the acting Person's, in their current workspace. */
  CreateWatch: Effect.fn('Rpc.CreateWatch')(function* (request: CreateWatchRequest) {
    const actor = yield* requireActor()
    const watch = yield* resolved(actor, (yield* Watches).create(actor, request))
    return WatchResponse.make({ watch })
  }),
  /**
   * The named Watch stays owned by the current Actor throughout revision: new filters and
   * instruction, or a check-in's next time (`ReviseWatchRequest`).
   */
  ReviseWatch: Effect.fn('Rpc.ReviseWatch')(function* (request: ReviseWatchRequest) {
    const actor = yield* requireActor()
    if (ReviseWatchRequest.guards.Timing(request))
      return WatchResponse.make({ watch: yield* (yield* Watches).updateCheckin(actor, request) })
    const watch = yield* resolved(
      actor,
      (yield* Watches).revise(actor, request).pipe(
        Effect.catchTag('WatchMissing', () =>
          Effect.fail(
            new NotFound({
              message: 'No Watch has that name, or it changed while revising. Read it again.',
            }),
          ),
        ),
      ),
    )
    return WatchResponse.make({ watch })
  }),
  ListWatches: Effect.fn('Rpc.ListWatches')(function* () {
    return yield* listed(yield* requireActor())
  }),
  /**
   * Ending by name: the model knows Watches only by the names they were given. A Watch is removed,
   * or finished by its own Run on evidence that its end condition is met.
   */
  StopWatch: Effect.fn('Rpc.StopWatch')(function* (request: StopWatchRequest) {
    const actor = yield* requireActor()
    const watches = yield* Watches
    const ended = StopWatchRequest.match(request, {
      Removed: ({ name }) => watches.stop(actor, name),
      Finished: ({ name, evidence }) => watches.complete(actor, name, evidence),
    })
    const watch = yield* ended.pipe(
      Effect.catchTag('WatchMissing', () =>
        Effect.fail(new NotFound({ message: 'No Watch has that name.' })),
      ),
    )
    return WatchResponse.make({ watch })
  }),
}
