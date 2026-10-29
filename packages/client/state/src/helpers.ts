import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { ChildRunState, RunId, type ChildRun, type WorkerKind } from '@vivid/contracts'
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

/** What a Person reads for what a helper is doing; product words, never the implementation's. */
const KIND: { readonly [Kind in WorkerKind]: string } = {
  ReadOnly: 'Reading',
  Researcher: 'Researching',
  Executor: 'Working',
  ComputerUse: 'Using the computer',
}

/** A helper's live state in a Person's words. */
export const helperStatus = (run: ChildRun) =>
  ChildRunState.match(run.state, {
    Reserved: () => 'Starting',
    Working: () => KIND[run.kind],
    Stopping: () => 'Stopping',
    Completed: () => 'Done',
    Failed: ({ reason }) =>
      reason._tag === 'DeadlinePassed' ? 'Ran out of time' : 'Could not finish',
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
