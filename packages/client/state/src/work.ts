import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  BackgroundWork,
  RunOrigin,
  WorkFailure,
  WorkRef,
  WorkStall,
  WorkStanding,
  WorkStopReport,
  WorkStopResult,
  WatchState,
  refOf,
  standingOf,
  stopsWith,
  type RunFailure,
  WorkNotStopped,
  type WorkStop,
} from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { spanOf } from './clock.js'
import { makeWhen, type Reader } from './when.js'

/**
 * What Vivid has going for the Person in the background, as every surface draws it: the words of
 * each row, the Stop press on one row, and Stop everything.
 *
 * The list is a live query (`WatchWork`, `BackgroundWork` in `@vivid/contracts`); it only mirrors
 * the server. A Stop is a press that asks the server, so it is a machine: one per piece of work,
 * keyed by its reference and kept in the surface's registry as the to-do close is (`todos.ts`),
 * so a row that is stopping stays so across a route change; and one Stop everything per surface,
 * because it reads and acts on the whole list. Its report stays on screen until dismissed: it is
 * the one place that says what could not be stopped (Grok Bot `StopSubagent {all:true}`).
 */

/** How strongly a row's standing reads. */
export type Tone = 'going' | 'stalled' | 'failing'

/** A row's standing in words, and how strongly it reads. */
interface Said {
  readonly tone: Tone
  readonly standing: string
}

/** One row: what it is, why it is there, where it stands, and the press that ends it. */
export interface WorkLine {
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly tone: Tone
  readonly standing: string
  readonly stop: WorkStop
}

/** The registry key of a piece of work: its kind and its id, which no two pieces share. */
export const keyOf = (ref: WorkRef): string =>
  WorkRef.match(ref, {
    Run: ({ run }) => `run:${run}`,
    Watch: ({ watch }) => `watch:${watch}`,
    MadeIntegration: ({ connection }) => `made:${connection}`,
  })

/** Why a Watch's last Run did not finish, short enough to stand after "Last time:". */
const FAILED = {
  Delivery: 'Vivid could not start on it',
  RateLimited: 'Vivid’s model was busy',
  ModelUnavailable: 'Vivid’s model could not be reached',
  NoAnswer: 'Vivid came back with nothing',
  TimedOut: 'Vivid took too long',
  Unexplained: 'Vivid could not finish',
} satisfies Record<RunFailure, string>

/** What a Run is doing, from what started it. */
const runDetail = (origin: RunOrigin) =>
  RunOrigin.match(origin, {
    Message: () => 'Answering you',
    FirstConversation: () => 'Getting to know you',
    Decision: () => 'Carrying on after your decision',
    Watch: ({ watchName }) => `Woken by “${watchName}”`,
    WatchUnrecorded: ({ watchName }) => `Woken by “${watchName}”`,
    Forget: () => 'Forgetting what you asked',
  })

/**
 * How long something has been stuck, to the minute: "34m", "2h 5m", "2d 3h". Seconds ticking
 * beside a stall add noise and nothing to act on; `spanOf` keeps them for work still going.
 */
const stuckFor = (ms: number) => {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** How many Watches listen to a made Integration; the section already says Vivid made it. */
const listeners = (count: number) => {
  if (count === 0) return 'Nothing watches it'
  return count === 1 ? '1 Watch listens to it' : `${count} Watches listen to it`
}

/**
 * Makes the sayer for one reader. A row's words come from one exhaustive match over its standing
 * (`standingOf`, the same function the server and Vivid's tool read), so "stalled" reads the same
 * on every surface.
 */
export function makeWorkWords(reader: Reader) {
  const when = makeWhen(reader)
  // The row's detail already names the account, so these do not say it again.
  const failure = (failed: WorkFailure) =>
    WorkFailure.match(failed, {
      LastRunFailed: ({ reason }) => `Last time: ${FAILED[reason]}`,
      IntegrationNeedsSignIn: () => 'Needs you to sign in again',
      IntegrationFailed: ({ reason }) => `Failed: ${reason}`,
    })
  const stall = (stalled: WorkStall, now: number) =>
    WorkStall.match(stalled, {
      WorkingLong: ({ since }) => `No answer after ${stuckFor(now - since)}`,
      NotConfirmed: () => 'Not confirmed yet',
      NotRenewed: ({ since }) => `Not renewed since ${when(since, now)} · events may be missed`,
    })
  /** A row going as it should: how long a Run has worked, when a Watch last woke Vivid. */
  const going = (work: BackgroundWork, now: number) =>
    BackgroundWork.match(work, {
      Run: ({ startedAt }) => `Working ${spanOf(now - startedAt)}`,
      Watch: ({ state, lastFiring }) => {
        if (WatchState.guards.Pending(state)) return 'Starting'
        if (lastFiring === null) return 'Has not fired yet'
        return `Last woke Vivid ${when(lastFiring.startedAt, now)}`
      },
      MadeIntegration: () => 'Ready',
    })
  return (work: BackgroundWork, now: number): WorkLine => {
    const { tone, standing } = WorkStanding.match(standingOf(work, now), {
      Going: (): Said => ({ tone: 'going', standing: going(work, now) }),
      Stalled: ({ stall: stalled }): Said => ({
        tone: 'stalled',
        standing: stall(stalled, now),
      }),
      Failing: ({ failure: failed }): Said => ({
        tone: 'failing',
        standing: failure(failed),
      }),
    })
    const { title, detail } = BackgroundWork.match(work, {
      Run: ({ title: thread, origin }) => ({ title: thread, detail: runDetail(origin) }),
      Watch: ({ name, account }) => ({ title: name, detail: account }),
      MadeIntegration: ({ account, watches }) => ({ title: account, detail: listeners(watches) }),
    })
    return { key: keyOf(refOf(work)), title, detail, tone, standing, stop: stopsWith(work) }
  }
}

/** Why a Stop did not take, short enough to stand under the work's own name. */
const NOT_STOPPED = {
  RuntimeUnreachable: 'Marked stopped, but Vivid did not answer, so it may still be working',
  IntegrationsUnreachable: 'Could not be removed right now. Try again in a moment',
} satisfies Record<WorkNotStopped, string>

/** What a Stop that did not take says on its own, naming the work it was about. */
export const notStoppedWords = (title: string, reason: WorkNotStopped) =>
  `“${title}”: ${NOT_STOPPED[reason]}.`

/** Whether a row is still drawn: one that is stopped, or that the server answered about, is not. */
export const isDrawn = (standing: RowStanding) =>
  !RowStanding.guards.Folded(standing) && !RowStanding.guards.Warned(standing)

/** The pieces Stop everything reaches, as the server chooses them: every one that stops without loss. */
export const stoppable = (all: ReadonlyArray<BackgroundWork>) =>
  all.filter((work) => stopsWith(work) === 'Stop')

/**
 * Names one press. The presser makes it, so a failed press pressed again is a new attempt, and an
 * answer about an earlier attempt can never finish a later one.
 */
export const AttemptId = Schema.String.pipe(Schema.brand('WorkAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** One press on one piece of work, with the work as it was listed, so its words outlive the row. */
const Delivery = Schema.Struct({ work: BackgroundWork, attempt: AttemptId })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

const sameAttempt = (
  one: { readonly attempt: AttemptId },
  other: { readonly attempt: AttemptId },
) => one.attempt === other.attempt

/** The server did not take the Stop, or its answer was lost. The row comes back to be pressed. */
export class StopRefused extends Schema.TaggedError<StopRefused>()(
  'WorkStopRefused',
  { attempt: AttemptId },
  { title: 'WorkStopRefused' },
) {}

/** A surface owns how the server is asked: the RPC client it already holds. */
export interface StoppingService {
  readonly stop: (delivery: Delivery) => Effect.Effect<WorkStopResult, StopRefused>
  readonly stopAll: (
    attempt: AttemptId,
  ) => Effect.Effect<ReadonlyArray<WorkStopReport>, StopRefused>
}

export class Stopper extends Context.Service<Stopper, StoppingService>()(
  '@vivid/state/work/Stopper',
) {}

/**
 * Where a Stop on one piece of work stands. `Sending` takes no second press; `Sent` holds the
 * server's answer (a Stop that did not take keeps its warning); `Unsent` puts the row back, saying
 * so, to be pressed again.
 */
export const StopStates = Machine.state({
  states: {
    Idle: {},
    Sending: { fields: Delivery.fields },
    Sent: { fields: { ...Delivery.fields, result: WorkStopResult } },
    Unsent: { fields: Delivery.fields },
  },
})
export type StopState = Parameters<typeof StopStates.matches>[0]

export const StopEvents = Machine.events({
  Stop: { work: BackgroundWork, attempt: AttemptId },
})

const deliveryOf = (event: Delivery): Delivery => ({ work: event.work, attempt: event.attempt })

/**
 * One piece of work's Stop. `Sending` is entered again from `Unsent`, so both outcomes carry the
 * attempt they answer and are declined when it is not the current one (`todos.ts` `CloseMachine`).
 */
export const StopMachine = Machine.make({
  id: 'WorkStop',
  root: StopStates,
  events: StopEvents,
  branches: { delivered: { sent: { target: 'Sent' }, unsent: { target: 'Unsent' } } },
  effects: {
    stop: (delivery: Delivery) =>
      Stopper.use((service) => service.stop(delivery)).pipe(
        Effect.map((result) => ({ ...delivery, result })),
      ),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: {
      on: { Stop: { target: 'Sending', data: ({ event }) => deliveryOf(event) } },
    },
    Sending: {
      invoke: {
        src: 'stop',
        input: ({ state }) => deliveryOf(state),
        onDone: {
          branches: 'delivered',
          declinable: true,
          resolve: (context) =>
            sameAttempt(context.output, context.state)
              ? context.select.sent({ data: context.output })
              : context.decline(),
        },
        onFailure: {
          branches: 'delivered',
          declinable: true,
          resolve: (context) =>
            sameAttempt(context.error, context.state)
              ? context.select.unsent({ data: deliveryOf(context.state) })
              : context.decline(),
        },
      },
    },
    Sent: {},
    Unsent: {
      on: { Stop: { target: 'Sending', data: ({ event }) => deliveryOf(event) } },
    },
  },
})

/** One piece of work's Stop in the app registry, with the surface's way of asking the server. */
export const makeStop = (services: Layer.Layer<Stopper>) =>
  AtomMachine.bind(Atom.runtime(services)).make(StopMachine)
export type StopAtoms = ReturnType<typeof makeStop>

/**
 * What a row reads from its Stop. `Folded`: stopped, gone from the list as soon as the server's
 * next answer arrives. `Warned`: the server answered that it could not stop it, and why; the row
 * folds too, because the server already calls it stopped, and the warning is said on its own.
 */
export const RowStanding = Schema.TaggedUnion({
  Shown: {},
  Stopping: {},
  Folded: {},
  Failed: {},
  Warned: { work: BackgroundWork, reason: WorkNotStopped },
})
export type RowStanding = typeof RowStanding.Type

export const rowStandingOf = (state: StopState): RowStanding =>
  Option.getOrElse(
    Option.firstSomeOf([
      Option.map(StopStates.get(state, 'Sending'), () => RowStanding.cases.Stopping.make({})),
      Option.map(StopStates.get(state, 'Unsent'), () => RowStanding.cases.Failed.make({})),
      Option.map(StopStates.get(state, 'Sent'), ({ work, result }) =>
        WorkStopResult.match(result, {
          Stopped: (): RowStanding => RowStanding.cases.Folded.make({}),
          AlreadyEnded: (): RowStanding => RowStanding.cases.Folded.make({}),
          NotStopped: ({ reason }): RowStanding => RowStanding.cases.Warned.make({ work, reason }),
        }),
      ),
    ]),
    () => RowStanding.cases.Shown.make({}),
  )

/**
 * Stop everything. `Armed` is the second press Grok Bot asks for before a reset ("Click Again to
 * Confirm"): the first press says what will stop, the second stops it. `Stopping` takes no other
 * press; `Reported` keeps the server's line per piece until the Person dismisses it; `Unsent`
 * says the call did not get through and offers it again.
 */
export const StopAllStates = Machine.state({
  states: {
    Idle: {},
    Armed: {},
    Stopping: { fields: { attempt: AttemptId } },
    Reported: { fields: { attempt: AttemptId, report: Schema.Array(WorkStopReport) } },
    Unsent: { fields: { attempt: AttemptId } },
  },
})
export type StopAllState = Parameters<typeof StopAllStates.matches>[0]

export const StopAllEvents = Machine.events({
  Arm: {},
  Disarm: {},
  Confirm: { attempt: AttemptId },
  Dismiss: {},
})

export const StopAllMachine = Machine.make({
  id: 'WorkStopAll',
  root: StopAllStates,
  events: StopAllEvents,
  branches: { answered: { reported: { target: 'Reported' }, unsent: { target: 'Unsent' } } },
  effects: {
    stopAll: (attempt: AttemptId) =>
      Stopper.use((service) => service.stopAll(attempt)).pipe(
        Effect.map((report) => ({ attempt, report })),
      ),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: { on: { Arm: { target: 'Armed' } } },
    Armed: {
      on: {
        Disarm: { target: 'Idle' },
        Confirm: { target: 'Stopping', data: ({ event }) => ({ attempt: event.attempt }) },
      },
    },
    Stopping: {
      invoke: {
        src: 'stopAll',
        input: ({ state }) => state.attempt,
        onDone: {
          branches: 'answered',
          declinable: true,
          resolve: (context) =>
            sameAttempt(context.output, context.state)
              ? context.select.reported({ data: context.output })
              : context.decline(),
        },
        onFailure: {
          branches: 'answered',
          declinable: true,
          resolve: (context) =>
            sameAttempt(context.error, context.state)
              ? context.select.unsent({ data: { attempt: context.state.attempt } })
              : context.decline(),
        },
      },
    },
    Reported: { on: { Dismiss: { target: 'Idle' }, Arm: { target: 'Armed' } } },
    Unsent: {
      on: {
        Confirm: { target: 'Stopping', data: ({ event }) => ({ attempt: event.attempt }) },
        Dismiss: { target: 'Idle' },
      },
    },
  },
})

/** A surface's Stop everything, with its way of asking the server. */
export const makeStopAll = (services: Layer.Layer<Stopper>) =>
  AtomMachine.bind(Atom.runtime(services)).make(StopAllMachine)
export type StopAllAtoms = ReturnType<typeof makeStopAll>

/** What Stop everything's control reads, worded by each surface from one match. */
export const AllStanding = Schema.TaggedUnion({
  Idle: {},
  Armed: {},
  Stopping: {},
  Reported: { report: Schema.Array(WorkStopReport) },
  Unsent: {},
})
export type AllStanding = typeof AllStanding.Type

export const allStandingOf = (state: StopAllState): AllStanding =>
  Option.getOrElse(
    Option.firstSomeOf([
      // Armed holds no data, so it has nothing to get; it is matched instead.
      StopAllStates.matches(state, 'Armed')
        ? Option.some(AllStanding.cases.Armed.make({}))
        : Option.none<AllStanding>(),
      Option.map(StopAllStates.get(state, 'Stopping'), () => AllStanding.cases.Stopping.make({})),
      Option.map(StopAllStates.get(state, 'Reported'), ({ report }) =>
        AllStanding.cases.Reported.make({ report }),
      ),
      Option.map(StopAllStates.get(state, 'Unsent'), () => AllStanding.cases.Unsent.make({})),
    ]),
    () => AllStanding.cases.Idle.make({}),
  )

/** One line of Stop everything's report, in words: what the piece was and what happened to it. */
export const reportLine = (line: WorkStopReport, words: (work: BackgroundWork) => WorkLine) => {
  const { title } = words(line.work)
  return WorkStopResult.match(line.result, {
    Stopped: () => ({ title, said: 'Stopped', failed: false }),
    AlreadyEnded: () => ({ title, said: 'Had already finished', failed: false }),
    NotStopped: ({ reason }) => ({ title, said: NOT_STOPPED[reason], failed: true }),
  })
}

/** "Stop 3 things": what the armed press will stop, counted from the list on screen. */
export const stopAllLabel = (count: number) =>
  count === 1 ? 'Press again to stop 1 thing' : `Press again to stop ${count} things`
