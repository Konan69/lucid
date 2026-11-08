import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import {
  BackgroundWork,
  InvalidRequest,
  type WorkRef,
  WorkStopReport,
  WorkStopResult,
  refOf,
  stopsWith,
  type ConnectionId,
  type RunId,
  type WatchId,
} from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { connectionOrigin, listRecords } from '../connections/records.ts'
import { ConnectionStore } from '../connections/store.ts'
import { stopPersonRun } from '../threads/stop.ts'
import { Watches } from '../watches/lifecycle.ts'
import { listWork } from './list.ts'

const stopped = () => WorkStopResult.cases.Stopped.make({})
const alreadyEnded = () => WorkStopResult.cases.AlreadyEnded.make({})

/**
 * Stop a Run acting for this Person: marked Stopped first, then the runtime is told to abort
 * (`threads/stop.ts`). A runtime that does not answer leaves a Run the database calls stopped and
 * the runtime may still be working on, which is said as such, never as Stopped.
 */
const stopRun = (actor: Actor, run: RunId) =>
  stopPersonRun(actor.person.id, run).pipe(
    Effect.map((changed) => (changed ? stopped() : alreadyEnded())),
    Effect.catchTag('RuntimeUnavailable', () =>
      Effect.succeed(WorkStopResult.cases.NotStopped.make({ reason: 'RuntimeUnreachable' })),
    ),
  )

/** Stop one of this Person's live Watches by id. One that is no longer live had already ended. */
const stopWatch = (actor: Actor, watch: WatchId) =>
  Effect.gen(function* () {
    return yield* (yield* Watches).stopById(actor, watch)
  }).pipe(
    Effect.as(stopped()),
    Effect.catchTag('WatchMissing', () => Effect.succeed(alreadyEnded())),
  )

/**
 * Remove an Integration Vivid made for itself. Only a Person removes one, and only a made one:
 * this call is never a way round Settings to remove an account the Person connected.
 */
const removeMade = (actor: Actor, connection: ConnectionId) =>
  Effect.gen(function* () {
    yield* requirePerson()
    const rows = yield* listRecords(actor)
    const row = Option.fromUndefinedOr(rows.find((one) => one.id === connection))
    if (Option.isNone(row)) return alreadyEnded()
    if (connectionOrigin(row.value.service) !== 'Made')
      return yield* new InvalidRequest({ message: 'Vivid did not make this Integration.' })
    return yield* (yield* ConnectionStore).remove(actor, connection).pipe(
      Effect.as(stopped()),
      Effect.catchTag('ServiceUnavailable', () =>
        Effect.succeed(WorkStopResult.cases.NotStopped.make({ reason: 'IntegrationsUnreachable' })),
      ),
    )
  })

/** Stop or remove one piece of background work, by the reference its listing gave. */
export const stopWork = Effect.fn('Work.stop')(function* (actor: Actor, work: WorkRef) {
  return yield* Match.valueTags(work, {
    Run: ({ run }) => stopRun(actor, run),
    Watch: ({ watch }) => stopWatch(actor, watch),
    MadeIntegration: ({ connection }) => removeMade(actor, connection),
  })
})

/**
 * Whether Stop everything reaches this piece of work. Removal is never part of it (`stopsWith`),
 * and when Vivid calls it from inside a Run, that Run's own Thread is left alone: interrupting the
 * caller would leave nobody to say what was stopped (Grok Bot's `StopSubagent {all:true}` stops
 * the children, not the agent that called it).
 */
const reaches = (actor: Actor) => (work: BackgroundWork) =>
  stopsWith(work) === 'Stop' &&
  !(BackgroundWork.guards.Run(work) && Option.contains(actor.threadId, work.thread))

/**
 * Watches go first, so no event starts a new Run while the Runs are being stopped. Within that,
 * the order the list gave.
 */
const watchesFirst = (all: ReadonlyArray<BackgroundWork>) => [
  ...all.filter(BackgroundWork.guards.Watch),
  ...all.filter((work) => !BackgroundWork.guards.Watch(work)),
]

/**
 * Stop everything that stops without loss, one piece at a time, and say for each what happened
 * (Grok Bot `grok-bot/grok-bot.md:137`, `:2507`). One piece that cannot be stopped does not hold
 * up the rest; a listed piece that is gone by the time it is reached had already ended.
 */
export const stopAllWork = Effect.fn('Work.stopAll')(function* (actor: Actor) {
  const listed = watchesFirst((yield* listWork(actor)).filter(reaches(actor)))
  return yield* Effect.forEach(listed, (work) =>
    stopWork(actor, refOf(work)).pipe(
      Effect.catchTag('NotFound', () => Effect.succeed(alreadyEnded())),
      Effect.map((result) => WorkStopReport.make({ work, result })),
    ),
  )
})
