import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import {
  BackgroundWork,
  ChildRunState,
  InvalidRequest,
  ShellSnapshot,
  NotFound,
  type WorkNotStopped,
  type WorkRef,
  WorkStopReport,
  WorkStopResult,
  refOf,
  stopsWith,
  type ConnectionId,
  type RunId,
  type ShellHandle,
  type WatchId,
} from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { markStopping, unmarkStopping } from '../computers/background.ts'
import { observeCommand, shellRefusals } from '../computers/commands.ts'
import { connectionOrigin, listRecords } from '../connections/records.ts'
import { ConnectionStore } from '../connections/store.ts'
import { ChildRuns } from '../runs/store.ts'
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

/**
 * Stop one of this Person's live Watches by id. The id is resolved to its name among their live
 * Watches in this same call, and the stop goes through `Watches.stop`, the one stop the model's
 * tool uses: a name is unique among a Person's live Watches (`vivid_watches_live_name`). One that
 * is no longer live had already ended.
 */
const stopWatch = (actor: Actor, watch: WatchId) =>
  Effect.gen(function* () {
    const watches = yield* Watches
    const live = (yield* watches.list(actor)).find((one) => one.id === watch)
    if (live === undefined) return alreadyEnded()
    return yield* watches.stop(actor, live.name).pipe(
      Effect.as(stopped()),
      Effect.catchTag('WatchMissing', () => Effect.succeed(alreadyEnded())),
    )
  })

/**
 * Stop a helper, through the same cancel a Person's Stop on it uses (`runs/store.ts` `cancel`).
 * Only a helper started by a Run acting for this Person is theirs to stop; one that has ended had
 * already ended. Whoever presses, the cancel records who asked: the Person, or Vivid for them.
 */
const stopHelper = (actor: Actor, helper: RunId) =>
  Effect.gen(function* () {
    const helpers = yield* ChildRuns
    const found = yield* helpers.find(helper)
    const owner = yield* helpers.actingFor(helper)
    if (Option.isNone(found) || !Option.contains(owner, actor.person.id))
      return yield* new NotFound({ message: 'Helper not found.' })
    const state = found.value.state
    if (
      ChildRunState.guards.Completed(state) ||
      ChildRunState.guards.Failed(state) ||
      ChildRunState.guards.Stopped(state)
    )
      return alreadyEnded()
    return yield* helpers.cancel(found.value, actor.by === 'person' ? 'Person' : 'Vivid').pipe(
      Effect.as(stopped()),
      Effect.catchTag('RuntimeUnavailable', () =>
        Effect.succeed(WorkStopResult.cases.NotStopped.make({ reason: 'RuntimeUnreachable' })),
      ),
    )
  })

/** What the Computer's answer to a stop says about the command. */
const commandStopped = (receipt: ShellSnapshot): WorkStopResult => {
  const notStopped = (reason: WorkNotStopped) => WorkStopResult.cases.NotStopped.make({ reason })
  return ShellSnapshot.match(receipt, {
    Stopped: (): WorkStopResult => stopped(),
    // It ended on its own first; its result still wakes its Thread.
    Completed: (): WorkStopResult => alreadyEnded(),
    Unknown: (): WorkStopResult => alreadyEnded(),
    Missing: (): WorkStopResult => alreadyEnded(),
    Running: (): WorkStopResult => notStopped('StillRunning'),
    // A stop never answers Queued; it is the Computer not having the command yet.
    Queued: (): WorkStopResult => notStopped('ComputerUnreachable'),
    Unavailable: (): WorkStopResult => notStopped('ComputerUnreachable'),
  })
}

/**
 * Stop a background command through its handle, as `stop_shell` does: the Computer's supervisor
 * kills the process group it started and is waited on for up to thirty seconds. The command is
 * marked first (`background.ts` `markStopping`), so the queue's next read spares its Thread the
 * wake; a Stop that did not end it takes the mark back, so it is listed and owed again.
 */
const stopCommand = (actor: Actor, handle: ShellHandle) =>
  Effect.gen(function* () {
    const person = actor.person.id
    if (!(yield* markStopping(person, handle))) return alreadyEnded()
    const receipt = yield* observeCommand(person, 'stop', { handle, seconds: 30 }).pipe(
      Effect.catchTags(shellRefusals),
      Effect.tapError(() => unmarkStopping(person, handle)),
    )
    const result = commandStopped(receipt)
    if (!WorkStopResult.guards.Stopped(result)) yield* unmarkStopping(person, handle)
    return result
  })

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
    Helper: ({ helper }) => stopHelper(actor, helper),
    Command: ({ handle }) => stopCommand(actor, handle),
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
  !(
    (BackgroundWork.guards.Run(work) || BackgroundWork.guards.Helper(work)) &&
    Option.contains(actor.threadId, work.thread)
  )

/**
 * Watches go first, so no event starts a new Run while the Runs are being stopped; helpers before
 * the Runs that started them, so each is stopped and reported on its own rather than swept up by
 * its parent's Thread Stop; background commands next, each through its own handle. Within each,
 * the order the list gave.
 */
const watchesFirst = (all: ReadonlyArray<BackgroundWork>) => [
  ...all.filter(BackgroundWork.guards.Watch),
  ...all.filter(BackgroundWork.guards.Helper),
  ...all.filter(BackgroundWork.guards.Command),
  ...all.filter(
    (work) =>
      !BackgroundWork.guards.Watch(work) &&
      !BackgroundWork.guards.Helper(work) &&
      !BackgroundWork.guards.Command(work),
  ),
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
