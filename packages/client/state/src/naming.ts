import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { PersonName } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * The Person giving themselves a name in Settings, the same on web, phone and desktop.
 *
 * The form is open from `Open` until `Close` or a save the server took. While a name is being
 * saved the form holds it and takes no second Save, so a double press sends one call; closing the
 * form leaves `Saving`, which interrupts the call, so a late answer has no form to land in. A
 * refused save keeps the form open with the name that was tried, for the Person to try again.
 *
 * What is typed is not part of the machine: it is the field's own text until Save turns it into a
 * `PersonName` (`typedName`), and nothing waits on it.
 */

/** The save did not land. The server keeps the name it had, and the live `Me` still shows it. */
export class Refused extends Schema.TaggedError<Refused>()(
  'PersonNameRefused',
  { name: PersonName },
  { title: 'PersonNameRefused' },
) {}

/** The surface owns the authenticated call and any expectation it lays over its live `Me`. */
export interface RenamingService {
  readonly rename: (name: PersonName) => Effect.Effect<void, Refused>
}

/** Each app supplies its own connection to the server. */
export class Renaming extends Context.Service<Renaming, RenamingService>()(
  '@vivid/state/naming/Renaming',
) {}

const States = Machine.state({
  states: {
    Closed: {},
    Editing: {},
    Saving: { fields: { name: PersonName } },
    Refused: { fields: { name: PersonName } },
  },
})
const Events = Machine.events({ Open: {}, Close: {}, Save: { name: PersonName } })
const save = {
  target: 'Saving',
  data: ({ event }: { readonly event: { readonly name: PersonName } }) => ({ name: event.name }),
} as const
const close = { target: 'Closed' } as const

const machine = Machine.make({
  id: 'PersonName',
  root: States,
  events: Events,
  effects: { rename: (name: PersonName) => Renaming.use((service) => service.rename(name)) },
}).handle({
  initial: { target: 'Closed' },
  states: {
    Closed: { on: { Open: { target: 'Editing' } } },
    Editing: { on: { Save: save, Close: close } },
    Saving: {
      invoke: {
        src: 'rename',
        input: ({ state }) => state.name,
        onDone: close,
        onFailure: { target: 'Refused', data: ({ state }) => ({ name: state.name }) },
      },
      on: { Close: close },
    },
    Refused: { on: { Save: save, Close: close } },
  },
})

/** The screen's exhaustive reading, including startup before the machine accepts events. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Closed: {},
  Editing: {},
  Saving: { name: PersonName },
  Refused: { name: PersonName },
})
export type Reading = typeof Reading.Type

/** Session-owned, so a refusal outlives the component that pressed and both surfaces read one. */
export const make = (services: Layer.Layer<Renaming>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    if (States.matches(state, 'Editing')) return Reading.cases.Editing.make({})
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Saving'), (saving) => Reading.cases.Saving.make(saving)),
        Option.map(States.get(state, 'Refused'), (refused) => Reading.cases.Refused.make(refused)),
      ]),
      () => Reading.cases.Closed.make({}),
    )
  })
  return { ...atoms, reading, open: Events.Open, close: Events.Close, save: Events.Save }
}

/** Whether the form is up. */
export const isOpen = Reading.isAnyOf(['Editing', 'Saving', 'Refused'])

/** Whether the form is waiting on the server: its Save is disabled and the machine refuses one. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Saving'])

/** What the form says under its field, from the machine alone. */
export const refusalOf = (reading: Reading): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Closed: () => Option.none(),
    Editing: () => Option.none(),
    Saving: () => Option.none(),
    Refused: () => Option.some('Your name was not saved. Try again.'),
  })

const decodeName = Schema.decodeUnknownOption(PersonName)

/** What was typed, as a name the server will take, once its ends are trimmed. */
export const typedName = (typed: string): Option.Option<PersonName> => decodeName(typed.trim())
