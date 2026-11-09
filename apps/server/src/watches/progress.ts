import { Effect, Option, Result, Schema } from 'effect'
import {
  WatchRunRequired,
  WatchEndConditionRequired,
  Watch,
  WatchCondition,
  WatchState,
  type ConnectionId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { actingRun, requestRuns } from '../threads/runs.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { WatchedApps } from './apps.ts'
import { ExecutorEvents } from './events.ts'
import type { Subscribe } from './lifecycle.ts'
import { WatchStore, subscriptionOf, type WatchRecord } from './store.ts'

/** The Actor has no live Watch by this name. */
export class WatchMissing extends Schema.TaggedError<WatchMissing>()(
  'WatchMissing',
  {},
  { title: 'Watch missing' },
) {}

/** Completion and authorization progress share the persisted Watch and admitted Run authority. */
export const watchProgress = Effect.fn('Watches.watchProgress')(function* (subscribe: Subscribe) {
  const store = yield* WatchStore
  const apps = yield* WatchedApps
  const events = yield* ExecutorEvents
  const database = yield* Database
  const changes = yield* Changes
  const publish = (record: WatchRecord) => changes.publish([Topic.person(record.personId)])

  /** The server binds completion and auth pauses to the admitted Run, never a model argument. */
  const current = Effect.fn('Watches.current')(
    function* (actor: Actor) {
      if (actor.by !== 'vivid' || Option.isNone(actor.threadId)) return Option.none()
      const runId = yield* actingRun(actor.threadId.value, actor.person.id).pipe(
        Effect.asSome,
        Effect.catchTag('NoActingRun', () => Effect.succeedNone),
      )
      if (Option.isNone(runId)) return Option.none()
      const run = (yield* requestRuns(actor.threadId.value, actor.person.id)).find(
        (run) => run.id === runId.value,
      )
      if (run === undefined || !StoredRunOrigin.isAnyOf(['Watch', 'Checkin'])(run.origin))
        return Option.none()
      return Option.some({ runId: run.id, watchId: run.origin.watchId })
    },
    (effect) => effect.pipe(Effect.provideService(Database, database)),
  )

  /** Only an Until Watch's own Run may finish it, after reading evidence of its condition. */
  const complete = Effect.fn('Watches.complete')(function* (
    actor: Actor,
    name: string,
    evidence: string,
  ) {
    const found = yield* store.named(actor, name)
    if (Option.isNone(found)) return yield* new WatchMissing({})
    const run = yield* current(actor)
    if (Option.isNone(run) || run.value.watchId !== found.value.watch.id)
      return yield* new WatchRunRequired({
        watchId: found.value.watch.id,
        message: 'Only the run this watch started can finish it.',
      })
    if (WatchCondition.guards.Continuous(found.value.watch.condition))
      return yield* new WatchEndConditionRequired({
        watchId: found.value.watch.id,
        message: 'This watch has no end condition, so it keeps watching until it is stopped.',
      })
    const completed = yield* store.complete(found.value.watch.id, run.value.runId, evidence)
    if (Option.isNone(completed)) return yield* new WatchMissing({})
    yield* publish(completed.value)
    yield* apps.callerOf(completed.value.connectionId).pipe(
      Effect.flatMap((caller) => events.unsubscribe(caller, subscriptionOf(completed.value))),
      Effect.ignore,
    )
    return Watch.make({ ...completed.value.watch, account: found.value.watch.account })
  })

  /** A timer may depend on another Integration. Retain the exact account that needs sign-in. */
  const pauseCurrent = Effect.fn('Watches.pauseCurrent')(function* (
    actor: Actor,
    connectionId: ConnectionId,
  ) {
    const run = yield* current(actor)
    if (Option.isNone(run)) return
    const paused = yield* store.pause(run.value.watchId, connectionId)
    if (Option.isSome(paused)) yield* publish(paused.value)
  })

  /** Same-Connection readiness is read after subscribe too, so a late grant cannot undo auth loss. */
  const reconnect = Effect.fn('Watches.reconnect')(function* (record: WatchRecord) {
    if (!WatchState.guards.Paused(record.watch.state)) return
    const connection = record.watch.state.connectionId
    if (!(yield* apps.isReady(connection))) return
    const grant = yield* Effect.result(
      apps
        .callerOf(record.connectionId)
        .pipe(Effect.flatMap((caller) => subscribe(caller, record))),
    )
    if (Result.isFailure(grant)) return
    if (!(yield* apps.isReady(connection))) return
    const resumed = yield* store.resume(
      record.watch.id,
      grant.success.refreshBefore.getTime(),
      connection,
    )
    if (Option.isSome(resumed)) yield* publish(resumed.value)
  })

  /** Called after a persisted Connection transition; renewal also repairs interrupted reconciliation. */
  const connectionChanged = Effect.fn('Watches.connectionChanged')(function* (
    connectionId: ConnectionId,
  ) {
    const needs = yield* apps.needsAuthorization(connectionId)
    for (const record of yield* store.allLive()) {
      if (needs && record.connectionId === connectionId) {
        const paused = yield* store.pause(record.watch.id, connectionId)
        if (Option.isSome(paused)) yield* publish(paused.value)
      }
      if (
        WatchState.guards.Paused(record.watch.state) &&
        record.watch.state.connectionId === connectionId
      )
        yield* reconnect(record)
    }
  })

  /** Reconcile persisted auth after a crash between Connection and Watch updates. */
  const reconcile = Effect.fn('Watches.reconcile')(function* () {
    for (const record of yield* store.allLive()) {
      if (yield* apps.needsAuthorization(record.connectionId)) {
        const paused = yield* store.pause(record.watch.id, record.connectionId)
        if (Option.isSome(paused)) yield* publish(paused.value)
      } else if (WatchState.guards.Paused(record.watch.state)) yield* reconnect(record)
    }
  })

  return { complete, pauseCurrent, connectionChanged, reconnect, reconcile }
})
