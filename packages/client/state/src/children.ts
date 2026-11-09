import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  ChildFailure,
  ChildRunState,
  RunId,
  roundOf,
  type ChildRun,
  type WorkerKind,
} from '@vivid/contracts'
import type { LiveEngine } from './live.js'
import { Context, Data, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/** The server refused or could not be reached; the helper is as the server last said. */
export class Refused extends Schema.TaggedError<Refused>()(
  'HelperStopRefused',
  { id: RunId },
  { title: 'HelperStopRefused' },
) {}

/** The surface owns authenticated transport (`CancelChildRun`). */
export interface StoppingService {
  readonly stop: (id: RunId) => Effect.Effect<void, Refused>
}

/** Each app supplies its existing authenticated RPC connection. */
export class Stopper extends Context.Service<Stopper, StoppingService>()(
  '@vivid/state/helpers/Stopper',
) {}

const Target = Schema.Struct({ id: RunId })
type Target = typeof Target.Type

const States = Machine.state({
  states: {
    Ready: {},
    Asking: { fields: Target.fields },
    Refused: { fields: Target.fields },
  },
})
const Events = Machine.events({ Stop: Target.fields })
const ask = {
  target: 'Asking',
  data: ({ event }: { readonly event: Target }) => ({ id: event.id }),
} as const

/**
 * One helper stop at a time in a session. While the server is asked, another press is not
 * taken; the answer is the helper's own state, which the Thread's live view then shows.
 */
const machine = Machine.make({
  id: 'HelperStop',
  root: States,
  events: Events,
  effects: { stop: (target: Target) => Stopper.use((service) => service.stop(target.id)) },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Stop: ask } },
    Asking: {
      invoke: {
        src: 'stop',
        input: ({ state }) => ({ id: state.id }),
        onDone: { target: 'Ready' },
        onFailure: { target: 'Refused', data: ({ state }) => ({ id: state.id }) },
      },
    },
    Refused: { on: { Stop: ask } },
  },
})

/** What a screen reads of the machine, including startup before it accepts a press. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Asking: { id: RunId },
  Refused: { id: RunId },
})
export type Reading = typeof Reading.Type

/** Session-owned atoms outlive the row that pressed, so scrolling it away cannot lose a refusal. */
export const make = (services: Layer.Layer<Stopper>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Asking'), (asking) => Reading.cases.Asking.make(asking)),
        Option.map(States.get(state, 'Refused'), (refused) => Reading.cases.Refused.make(refused)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, stop: Events.Stop }
}

/** Every Stop control waits while any stop is being asked; the machine refuses the press too. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Asking'])

/** The refused helper keeps its own line beside its row. */
export const refusalFor = (reading: Reading, id: RunId): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Ready: () => Option.none(),
    Asking: () => Option.none(),
    Refused: (refused) =>
      refused.id === id
        ? Option.some('It could not be stopped just now. Try again.')
        : Option.none(),
  })

/** Whether a helper can still be stopped: it has not ended and no stop is under way. */
export const stoppable = (run: ChildRun) =>
  ChildRunState.isAnyOf(['Reserved', 'Working'])(run.state)

/** The server refused a follow-up or could not be reached; the helper is as the server last said. */
export class FollowUpRefused extends Schema.TaggedError<FollowUpRefused>()(
  'HelperFollowUpRefused',
  { id: RunId },
  { title: 'HelperFollowUpRefused' },
) {}

/**
 * The surface owns authenticated transport (`FollowUpChildRun`). `key` is the press's own, made by
 * the surface when the Person sends, so the server takes a repeat of it once.
 */
export interface SendingService {
  readonly send: (draft: Draft) => Effect.Effect<void, FollowUpRefused>
}

/** Each app supplies its existing authenticated RPC connection. */
export class Sender extends Context.Service<Sender, SendingService>()(
  '@vivid/state/helpers/Sender',
) {}

const Draft = Schema.Struct({ id: RunId, message: Schema.String, key: Schema.String })
type Draft = typeof Draft.Type

const FollowStates = Machine.state({
  states: {
    Ready: {},
    Sending: { fields: Draft.fields },
    Refused: { fields: Target.fields },
  },
})
const FollowEvents = Machine.events({ Send: Draft.fields })
const sending = {
  target: 'Sending',
  data: ({ event }: { readonly event: Draft }) => ({
    id: event.id,
    message: event.message,
    key: event.key,
  }),
} as const

/**
 * One follow-up at a time in a session, as one stop is. The words go to the server with the
 * press's key; the answer is the helper's own new round, which the Thread's live view then shows.
 */
const followMachine = Machine.make({
  id: 'HelperFollowUp',
  root: FollowStates,
  events: FollowEvents,
  effects: { send: (draft: Draft) => Sender.use((service) => service.send(draft)) },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Send: sending } },
    Sending: {
      invoke: {
        src: 'send',
        input: ({ state }) => ({ id: state.id, message: state.message, key: state.key }),
        onDone: { target: 'Ready' },
        onFailure: { target: 'Refused', data: ({ state }) => ({ id: state.id }) },
      },
    },
    Refused: { on: { Send: sending } },
  },
})

/** What a screen reads of the follow-up machine, including startup before it accepts a press. */
export const FollowReading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Sending: { id: RunId },
  Refused: { id: RunId },
})
export type FollowReading = typeof FollowReading.Type

/** Session-owned atoms, so a refusal outlives the row that sent it. */
export const makeFollowUps = (services: Layer.Layer<Sender>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(followMachine)
  const reading = Atom.map(atoms.snapshot, (result): FollowReading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return FollowReading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(FollowStates.get(state, 'Sending'), (at) =>
          FollowReading.cases.Sending.make({ id: at.id }),
        ),
        Option.map(FollowStates.get(state, 'Refused'), (at) =>
          FollowReading.cases.Refused.make(at),
        ),
      ]),
      () => FollowReading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, followUp: FollowEvents.Send }
}

/** Every Send waits while a follow-up is being asked; the machine refuses the press too. */
export const isSending = FollowReading.isAnyOf(['Starting', 'Sending'])

/** The refused helper keeps its own line under its words, which stay in its field. */
export const followRefusalFor = (reading: FollowReading, id: RunId): Option.Option<string> =>
  FollowReading.match(reading, {
    Starting: () => Option.none(),
    Ready: () => Option.none(),
    Sending: () => Option.none(),
    Refused: (refused) =>
      refused.id === id ? Option.some('It could not be sent just now. Try again.') : Option.none(),
  })

/**
 * Whether a helper takes a follow-up: one at work takes it at its next step, one that finished a
 * round starts its next. One not started yet, stopping or stopped takes none.
 */
export const followable = (run: ChildRun) =>
  ChildRunState.isAnyOf(['Working', 'Completed', 'Failed'])(run.state)

/**
 * The round a helper is in, which a row's field is keyed by: once a follow-up lands the helper's
 * next round shows and the field starts empty; a refused one leaves the round, and the words.
 */
export const roundIn = (run: ChildRun) => roundOf(run.turn)

/** What a Person reads for what a helper is doing; product words, never the implementation's. */
const KIND = {
  ReadOnly: 'Reading',
  Researcher: 'Researching',
  Executor: 'Working',
  ComputerUse: 'Using the computer',
} satisfies { readonly [Kind in WorkerKind]: string }

/** A helper's live state in a Person's words. */
export const helperStatus = (run: ChildRun) =>
  ChildRunState.match(run.state, {
    Reserved: () => 'Starting',
    Working: () => KIND[run.kind],
    Stopping: () => 'Stopping',
    Completed: () => 'Done',
    Failed: ({ reason }) =>
      ChildFailure.guards.DeadlinePassed(reason) ? 'Ran out of time' : 'Could not finish',
    Stopped: () => 'Stopped',
  })

/**
 * The helpers one reply of Vivid's started, drawn once, at its first `spawn_run` step: `calls`
 * are that reply's tool calls in order. A reply that started none, and every later step of one
 * that did, draws nothing.
 */
export const startedIn = (
  children: ReadonlyArray<ChildRun>,
  calls: ReadonlyArray<{ readonly toolName: string; readonly toolCallId: string }>,
  at: string,
) => {
  const spawned = calls.filter((call) => call.toolName === 'spawn_run')
  if (spawned[0] === undefined || spawned[0].toolCallId !== at) return []
  const ids = new Set(spawned.map((call) => call.toolCallId))
  return children.filter((run) => ids.has(run.parentToolCallId))
}

/** Which reading of a helper's result: its id and where it stood when it was asked. */
export class ResultKey extends Data.Class<{ readonly id: RunId; readonly state: string }> {}

/** The key `results` reads one helper under now. */
export const resultKey = (run: ChildRun) => new ResultKey({ id: run.id, state: run.state._tag })

/**
 * One helper as it opens: its result once it ended, read from the runtime through the server
 * (`GetChildRun`). It is asked again whenever the helper's state changes, so a row opened while
 * it worked shows the result once it ends.
 */
export const results = (engine: LiveEngine) =>
  Atom.family((key: ResultKey) =>
    engine.ask(Atom.make(key.id), (client, id) => client.GetChildRun({ id })),
  )
