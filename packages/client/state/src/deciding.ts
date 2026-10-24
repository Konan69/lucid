import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { Device, DeviceId } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/** One explicit access decision. Presence and phone sign-in sessions confer no permission. */
const Decision = Schema.Struct({ device: Device, allow: Schema.Boolean })
type Decision = typeof Decision.Type

/** A refused decision leaves the server's Pending request visible and retryable. */
export class Refused extends Schema.TaggedError<Refused>()(
  'DeviceDecisionRefused',
  { id: DeviceId },
  { title: 'DeviceDecisionRefused' },
) {}

/** The surface owns authenticated transport and any optimistic expectations. */
export interface SendingService {
  readonly send: (decision: Decision) => Effect.Effect<void, Refused>
}

/** Each app supplies its existing authenticated RPC connection. */
export class Sending extends Context.Service<Sending, SendingService>()(
  '@vivid/state/deciding/Sending',
) {}

const States = Machine.state({
  states: {
    Ready: {},
    Sending: { fields: Decision.fields },
    Refused: { fields: Decision.fields },
  },
})
const Events = Machine.events({ Decide: Decision.fields })
const decide = {
  target: 'Sending',
  data: ({ event }: { readonly event: Decision }) => ({ device: event.device, allow: event.allow }),
} as const

/** One decision at a time across Feed, Settings and Threads. Sending accepts no further press. */
const machine = Machine.make({
  id: 'DeviceDecision',
  root: States,
  events: Events,
  effects: { send: (decision: Decision) => Sending.use((service) => service.send(decision)) },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Decide: decide } },
    Sending: {
      invoke: {
        src: 'send',
        input: ({ state }) => ({ device: state.device, allow: state.allow }),
        onDone: { target: 'Ready' },
        onFailure: {
          target: 'Refused',
          data: ({ state }) => ({ device: state.device, allow: state.allow }),
        },
      },
    },
    Refused: { on: { Decide: decide } },
  },
})

/** The screen's exhaustive reading, including startup before the machine accepts decisions. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Sending: { device: Device, allow: Schema.Boolean },
  Refused: { device: Device, allow: Schema.Boolean },
})
export type Reading = typeof Reading.Type

/** Session-owned atoms outlive the component that pressed, so navigation cannot lose a refusal. */
export const make = (services: Layer.Layer<Sending>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Sending'), (sending) => Reading.cases.Sending.make(sending)),
        Option.map(States.get(state, 'Refused'), (refused) => Reading.cases.Refused.make(refused)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, decide: Events.Decide }
}

/** All access controls share the same waiting state and the machine refuses duplicate presses. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Sending'])

/** The failed computer keeps its own error beside its controls on every screen. */
export const refusalFor = (reading: Reading, id: DeviceId): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Ready: () => Option.none(),
    Sending: () => Option.none(),
    Refused: ({ device }) =>
      device.id === id
        ? Option.some(`The decision for ${device.name} could not be saved. Try again.`)
        : Option.none(),
  })
