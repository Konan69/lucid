import { DeviceAnswer, WindowResult, type RunId, type WindowAction } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import { NoticeState } from '../shared/notice.ts'
import { startHelper, type Helper, type HelperCommand } from './helper.ts'
import { HelperCall, HelperReply } from './wire.ts'
import { Performed, blankTable, perform, type Table } from './windows.ts'

/**
 * Vivid's turns on the Person's computer: when the helper runs, when a turn begins and ends,
 * what the notice says, and what a stop does.
 *
 * The rules, each from the helper's README ("What the desktop app must do") or the contract
 * (`DeviceRequest` in `packages/contracts/src/computers.ts`):
 * - One turn per Run, and the Run's id is the turn's id. The turn begins at the first work in an
 *   app of that Run, and the notice goes up with it. It ends when the server says the Run ended,
 *   when no work has come for `IDLE_TURN`, when work of a different Run arrives, when the link to
 *   Vivid ends, and when the app quits.
 * - A stop ends the turn, and nothing more. The Person pressing Escape (the helper's `stopped`
 *   line) or Stop on the notice: work in flight is answered `Declined: Stopped`; with nothing in
 *   flight the stopped Run is put on `stops`, for the link to tell the server at once. The notice
 *   comes down. That Run's turn is not begun again; a new Run works at once. There is no pause
 *   after a stop and nothing is kept about it beyond the one Run it ended.
 * - The helper is started at the first work in an app, not before, and is one process. If it
 *   dies it is started again by the next work; nothing is replayed.
 * - Work whose outcome is not known is not answered (`Performed.Unknown`).
 *
 * Once the Person has allowed their computer nothing is asked and nothing is refused here: this
 * module has no list of apps Vivid may or may not use.
 */

/** How long a turn stays open with no work before it is ended and the notice taken down. */
export const IDLE_TURN = Duration.seconds(60)

/** What beginning or ending a turn may take: these do nothing slow in the helper. */
const TURN_BUDGET_MS = 3_000

export interface TurnDependencies {
  /** How to start the helper, when this computer has one. */
  readonly helper: Option.Option<HelperCommand>
  /** Says what the notice shows now. `Hidden` takes it down. */
  readonly notice: (state: NoticeState) => void
}

/** One piece of work in an app, as the link hands it over. */
export interface WindowWork {
  readonly runId: RunId
  readonly action: WindowAction
  readonly expiresAt: number
}

/** What reaches this module from outside a fiber: the helper's lines and the notice's button. */
const Signal = Schema.TaggedUnion({
  /** The helper's `stopped` line: Escape, during the turn with this id. */
  Escaped: { turn: Schema.String },
  /** Stop on the notice. */
  StopPressed: {},
  /** The helper process is gone. `generation` says which one, so an old exit is not a new one. */
  HelperGone: { generation: Schema.Int },
})

interface Running {
  readonly helper: Helper
  readonly scope: Scope.Closeable
  readonly generation: number
}
interface Turn {
  readonly runId: RunId
  readonly table: Table
}
interface Flying {
  readonly runId: RunId
  readonly stop: Deferred.Deferred<void>
}

/** The helper would not begin a turn for this Run. `answer` is what that means for the work. */
class NotBegun extends Schema.TaggedError<NotBegun>()(
  'NotBegun',
  { answer: DeviceAnswer },
  { title: 'The helper did not begin the turn' },
) {}

const isStopped = (answer: DeviceAnswer) =>
  DeviceAnswer.guards.Declined(answer) && answer.reason === 'Stopped'

const declinedStopped: DeviceAnswer = DeviceAnswer.cases.Declined.make({ reason: 'Stopped' })
const unsupported: DeviceAnswer = DeviceAnswer.cases.Declined.make({ reason: 'Unsupported' })
const failed: DeviceAnswer = DeviceAnswer.cases.Failed.make({})

/** The app a result shows, when it shows a window: what the notice then names. */
const appShown = (result: WindowResult): Option.Option<string> =>
  WindowResult.match(result, {
    Apps: () => Option.none(),
    Windows: () => Option.none(),
    Closed: () => Option.none(),
    Seen: ({ view }) => Option.some(view.app),
    Typed: ({ view }) => Option.some(view.app),
    Closing: ({ view }) => Option.some(view.app),
  })

/** What beginning a turn the helper refused means for the work that needed it. */
const notBegun = (name: string): DeviceAnswer => {
  // The helper holds this Run as stopped: its turn is over for good.
  if (name === 'PersonStopped') return declinedStopped
  // No Escape hooks, so no way for the Person to stop Vivid, so no turn.
  if (name === 'HookUnavailable') return unsupported
  return failed
}

/**
 * Everything the keeper holds. One object, so each rule below is a function of it and can be
 * read by itself. The fields change only inside `Effect.sync` and the signal handlers.
 */
interface Keeper {
  readonly dependencies: TurnDependencies
  readonly scope: Scope.Scope
  /** Work, a Run ending, the idle end and the link ending take turns: each changes the turn. */
  readonly serial: Semaphore.Semaphore
  readonly signals: Queue.Queue<typeof Signal.Type>
  readonly stops: Queue.Queue<RunId>
  running: Option.Option<Running>
  turn: Option.Option<Turn>
  flying: Option.Option<Flying>
  /** The one Run the Person last stopped. Its turn is over for good; other Runs are untouched. */
  stoppedRun: Option.Option<RunId>
  idle: Option.Option<Fiber.Fiber<void>>
  /** Counts every piece of work, so an idle end that woke late can tell work came since. */
  touched: number
  generations: number
}

const hidden = NoticeState.cases.Hidden.make({})

/** Takes the turn out of the keeper and, if there was one, the notice down. Says which it was. */
const dropTurn = (keeper: Keeper) =>
  Effect.sync(() => {
    const dropped = keeper.turn
    keeper.turn = Option.none()
    if (Option.isSome(dropped)) keeper.dependencies.notice(hidden)
    return dropped
  })

const cancelIdle = (keeper: Keeper) =>
  Effect.suspend(() => {
    const waiting = keeper.idle
    keeper.idle = Option.none()
    return Option.match(waiting, { onNone: () => Effect.void, onSome: Fiber.interrupt })
  })

/** Tells the helper the turn is over. Its reply changes nothing: the turn is over here anyway. */
const releaseHelper = (keeper: Keeper, runId: RunId) =>
  Effect.suspend(() =>
    Option.match(keeper.running, {
      onNone: () => Effect.void,
      onSome: ({ helper }) =>
        helper
          .ask({
            call: HelperCall.cases.EndTurn.make({}),
            turn: Option.some(runId),
            budget: TURN_BUDGET_MS,
          })
          .pipe(Effect.asVoid),
    }),
  )

/** Ends the turn in progress, if there is one: notice down, idle end cancelled, helper told. */
const endTurn = Effect.fn('DesktopTurn.end')(function* (keeper: Keeper) {
  yield* cancelIdle(keeper)
  const dropped = yield* dropTurn(keeper)
  if (Option.isSome(dropped)) yield* releaseHelper(keeper, dropped.value.runId)
})

/** Ends the helper process. The next work starts a new one. */
const stopHelper = (keeper: Keeper) =>
  Effect.suspend(() => {
    const current = keeper.running
    keeper.running = Option.none()
    return Option.match(current, {
      onNone: () => Effect.void,
      onSome: ({ scope }) => Scope.close(scope, Exit.void),
    })
  })

/**
 * The Person stopped this Run. Work in flight is answered `Declined: Stopped`; with nothing in
 * flight the Run goes on `stops`, to be reported at once. Said twice it changes nothing: the
 * helper refusing the request in flight and its `stopped` line both report the same Escape.
 */
const personStopped = (keeper: Keeper, runId: RunId) =>
  Effect.sync(() => {
    if (Option.contains(keeper.stoppedRun, runId)) return
    keeper.stoppedRun = Option.some(runId)
    const inFlight = Option.filter(keeper.flying, (current) => current.runId === runId)
    if (Option.isSome(inFlight)) Deferred.doneUnsafe(inFlight.value.stop, Effect.void)
    else Queue.offerUnsafe(keeper.stops, runId)
  })

/** Escape, as the helper's `stopped` line. The helper has already ended that turn itself. */
const escaped = Effect.fn('DesktopTurn.escaped')(function* (keeper: Keeper, turn: string) {
  const current = Option.filter(keeper.turn, ({ runId }) => runId === turn)
  if (Option.isNone(current)) return
  yield* cancelIdle(keeper)
  yield* dropTurn(keeper)
  yield* personStopped(keeper, current.value.runId)
})

/**
 * Stop on the notice. The helper has no stop of its own to call; ending the turn removes its
 * hooks and its authority. It is asked after the request in flight, which the helper finishes
 * first, and the notice says "Stopping" until then.
 */
const stopPressed = Effect.fn('DesktopTurn.stopPressed')(function* (keeper: Keeper) {
  const current = keeper.turn
  if (Option.isNone(current)) return
  yield* cancelIdle(keeper)
  keeper.turn = Option.none()
  keeper.dependencies.notice(NoticeState.cases.Stopping.make({}))
  yield* personStopped(keeper, current.value.runId)
  yield* releaseHelper(keeper, current.value.runId)
  keeper.dependencies.notice(hidden)
})

/** The helper process went away by itself: the turn went with it. The next work starts anew. */
const helperGone = Effect.fn('DesktopTurn.helperGone')(function* (
  keeper: Keeper,
  generation: number,
) {
  if (!Option.exists(keeper.running, (current) => current.generation === generation)) return
  yield* cancelIdle(keeper)
  yield* dropTurn(keeper)
  yield* stopHelper(keeper)
})

const heard = (keeper: Keeper, signal: typeof Signal.Type) =>
  Signal.match(signal, {
    Escaped: ({ turn }) => escaped(keeper, turn),
    StopPressed: () => stopPressed(keeper),
    HelperGone: ({ generation }) => helperGone(keeper, generation),
  })

/** The helper process, started now if it is not running. */
const helperNow = Effect.fn('DesktopTurn.helper')(function* (
  keeper: Keeper,
  command: HelperCommand,
) {
  if (Option.isSome(keeper.running)) return keeper.running.value.helper
  keeper.generations += 1
  const generation = keeper.generations
  const scope = yield* Scope.fork(keeper.scope)
  const helper = yield* startHelper(command, {
    stopped: (event) => {
      Queue.offerUnsafe(keeper.signals, Signal.cases.Escaped.make({ turn: event.turn }))
    },
    gone: () => {
      Queue.offerUnsafe(keeper.signals, Signal.cases.HelperGone.make({ generation }))
    },
  }).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  )
  keeper.running = Option.some({ helper, scope, generation })
  return helper
})

/** The idle end itself, once its minute has passed: only if no work came since it was armed. */
const idleEnd = (keeper: Keeper, runId: RunId, stamp: number) =>
  Effect.suspend(() => {
    // This fiber is the idle end now; ending the turn must not interrupt itself.
    keeper.idle = Option.none()
    const still =
      stamp === keeper.touched && Option.exists(keeper.turn, (now) => now.runId === runId)
    return still ? endTurn(keeper) : Effect.void
  }).pipe(Semaphore.withPermit(keeper.serial))

/** Ends this Run's turn after `IDLE_TURN` with no work, unless work comes first. */
const armIdle = Effect.fn('DesktopTurn.armIdle')(function* (keeper: Keeper, runId: RunId) {
  yield* cancelIdle(keeper)
  keeper.touched += 1
  const ending = Effect.sleep(IDLE_TURN).pipe(
    Effect.andThen(idleEnd(keeper, runId, keeper.touched)),
  )
  keeper.idle = Option.some(yield* Effect.forkIn(ending, keeper.scope))
})

/**
 * The turn for this Run, begun now if it is not the one in progress. Work of another Run ends
 * the turn in progress first: the helper has one turn, and a turn is one Run's.
 */
const turnFor = Effect.fn('DesktopTurn.turnFor')(function* (
  keeper: Keeper,
  helper: Helper,
  runId: RunId,
) {
  const current = Option.filter(keeper.turn, (now) => now.runId === runId)
  if (Option.isSome(current)) return current.value
  yield* endTurn(keeper)
  const reply = yield* helper.ask({
    call: HelperCall.cases.BeginTurn.make({}),
    turn: Option.some(runId),
    budget: TURN_BUDGET_MS,
  })
  // The helper would not begin, or is gone. Nothing was done.
  yield* HelperReply.match<Effect.Effect<void, NotBegun>>(reply, {
    Answered: () => Effect.void,
    Lost: () => Effect.fail(new NotBegun({ answer: failed })),
    Refused: ({ name }) => Effect.fail(new NotBegun({ answer: notBegun(name) })),
  })
  const begun: Turn = { runId, table: blankTable() }
  keeper.turn = Option.some(begun)
  keeper.dependencies.notice(NoticeState.cases.Working.make({}))
  return begun
})

/** What the keeper does with how the work ended: the answer to send, or none. */
const settle = (keeper: Keeper, performed: Performed) =>
  Performed.match(performed, {
    Unknown: () => Effect.succeed(Option.none<DeviceAnswer>()),
    // No hooks, no Escape: the Person could not stop Vivid, so Vivid does not go on.
    HooksLost: () => endTurn(keeper).pipe(Effect.as(Option.some(unsupported))),
    Answered: ({ answer }) =>
      Effect.sync(() => {
        if (DeviceAnswer.guards.Did(answer))
          Option.map(appShown(answer.result), (app) =>
            keeper.dependencies.notice(NoticeState.cases.WorkingIn.make({ app })),
          )
        return Option.some(answer)
      }),
  })

/** One piece of work through the helper, to its answer or to no answer. */
const work = Effect.fn('DesktopTurn.work')(function* (
  keeper: Keeper,
  command: HelperCommand,
  input: WindowWork,
) {
  const helper = yield* helperNow(keeper, command)
  const begun = yield* turnFor(keeper, helper, input.runId)
  // Each request gets what is left of this work's deadline, cut to the helper's own ceiling.
  const asking = Effect.fn('DesktopTurn.ask')(function* (call: HelperCall) {
    const now = yield* Clock.currentTimeMillis
    return yield* helper.ask({
      call,
      turn: Option.some(input.runId),
      budget: input.expiresAt - now,
    })
  })
  const performed = yield* perform(asking, begun.table, input.action)
  yield* armIdle(keeper, input.runId)
  return yield* settle(keeper, performed)
})

/** The same, with the two ways it cannot start turned into their answers. */
const worked = (keeper: Keeper, command: HelperCommand, input: WindowWork) =>
  work(keeper, command, input).pipe(
    Effect.catchTags({
      HelperUnavailable: () => Effect.succeed(Option.some(failed)),
      NotBegun: ({ answer }) => Effect.succeed(Option.some(answer)),
    }),
  )

/**
 * Carries out one piece of work and returns its answer, or nothing when there is no one to
 * answer or nothing honest to say: its deadline had passed or passed meanwhile (the server has
 * already recorded it as unknown), or a change was sent and its outcome is not known.
 */
const execute = Effect.fn('DesktopTurn.execute')(function* (keeper: Keeper, input: WindowWork) {
  const now = yield* Clock.currentTimeMillis
  if (now >= input.expiresAt) return Option.none<DeviceAnswer>()
  if (Option.contains(keeper.stoppedRun, input.runId)) return Option.some(declinedStopped)
  // No helper on this computer: the ability said so, and the server should not have asked.
  const command = keeper.dependencies.helper
  if (Option.isNone(command)) return Option.some(unsupported)
  const stop = yield* Deferred.make<void>()
  keeper.flying = Option.some({ runId: input.runId, stop })
  const answer = yield* Effect.raceFirst(
    worked(keeper, command.value, input),
    Deferred.await(stop).pipe(Effect.as(Option.some(declinedStopped))),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.expiresAt - now)),
    Effect.map(Option.flatten),
    Effect.ensuring(
      Effect.sync(() => {
        keeper.flying = Option.none()
      }),
    ),
  )
  // The helper answering `PersonStopped` is the same stop as its `stopped` line.
  if (Option.exists(answer, isStopped)) {
    yield* cancelIdle(keeper)
    yield* dropTurn(keeper)
    keeper.stoppedRun = Option.some(input.runId)
  }
  return answer
})

/**
 * Makes the turn keeper. It lives in the scope it is made in: closing that scope ends the
 * helper process with everything else.
 */
export const turns = Effect.fn('DesktopTurn.make')(function* (dependencies: TurnDependencies) {
  const keeper: Keeper = {
    dependencies,
    scope: yield* Effect.scope,
    serial: yield* Semaphore.make(1),
    signals: yield* Queue.unbounded<typeof Signal.Type>(),
    stops: yield* Queue.unbounded<RunId>(),
    running: Option.none(),
    turn: Option.none(),
    flying: Option.none(),
    stoppedRun: Option.none(),
    idle: Option.none(),
    touched: 0,
    generations: 0,
  }
  const listening = Queue.take(keeper.signals).pipe(
    Effect.flatMap((signal) => heard(keeper, signal)),
  )
  yield* Effect.forkScoped(Effect.forever(listening))
  const serially = Semaphore.withPermit(keeper.serial)
  return {
    /** Whether this computer can work in apps at all: it has the helper. */
    apps: Option.isSome(dependencies.helper),
    execute: (input: WindowWork) => serially(execute(keeper, input)),
    /** The server said this Run is over: its turn ends and the notice comes down. */
    ended: (runId: RunId) =>
      serially(
        Effect.suspend(() =>
          Option.exists(keeper.turn, (now) => now.runId === runId) ? endTurn(keeper) : Effect.void,
        ),
      ),
    /** The link to Vivid ended, or the app is quitting: the turn ends and the helper with it. */
    unlinked: serially(endTurn(keeper).pipe(Effect.andThen(stopHelper(keeper)))),
    /** Stop on the notice. Callable from outside any fiber. */
    stop: (): void => {
      Queue.offerUnsafe(keeper.signals, Signal.cases.StopPressed.make({}))
    },
    /** The Runs the Person stopped with nothing in flight, for the link to report at once. */
    stops: Queue.asDequeue(keeper.stops),
  }
})
