import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { ArtifactId } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * A Person deleting one of a Thread's Artifacts from its viewer, the same on web, phone and
 * desktop (`RemoveArtifact`). The surface has already asked "Delete …?" and the Person said yes.
 *
 * A deletion that lands needs nothing said by this machine: the viewer's live query
 * (`WatchArtifact`) ends with `NotFound`, and the viewer already says the Artifact was removed. A
 * refusal (the connection, or someone who may read the Thread but not remove from it) is kept
 * beside that Artifact's actions until the next press, and outlives the dialog or sheet closing.
 *
 * It is session-owned, like `opening`: one deletion at a time. Each press carries its own attempt
 * id and `Removing` is entered again from `Refused`, so every outcome says the attempt it answers
 * and is declined when that is not the current one (`owed.ts`, the 0.46 queued-outcome rule).
 */

/** Names one press. The presser makes it; the outcome says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('RemovingAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** One press: which Artifact. */
const Removal = Schema.Struct({ attempt: AttemptId, id: ArtifactId })
export type Removal = typeof Removal.Type

/** The server did not remove it; it is still there. */
export class Unremoved extends Schema.TaggedError<Unremoved>()(
  'ArtifactUnremoved',
  { removal: Removal },
  { title: 'ArtifactUnremoved' },
) {}

/** The surface owns the authenticated call. */
export interface RemovingService {
  readonly remove: (removal: Removal) => Effect.Effect<void, Unremoved>
}

export class Remover extends Context.Service<Remover, RemovingService>()(
  '@vivid/state/removing/Remover',
) {}

const States = Machine.state({
  states: {
    Idle: {},
    Removing: { fields: Removal.fields },
    Refused: { fields: { id: ArtifactId } },
  },
})

const Events = Machine.events({ Remove: Removal.fields })

const remove = {
  target: 'Removing',
  data: ({ event }: { readonly event: Removal }) => Removal.make(event),
} as const

const machine = Machine.make({
  id: 'ArtifactRemoval',
  root: States,
  events: Events,
  branches: { removed: { idle: { target: 'Idle' }, refused: { target: 'Refused' } } },
  effects: {
    remove: (removal: Removal) =>
      Remover.use((service) => service.remove(removal)).pipe(Effect.as(removal)),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: { on: { Remove: remove } },
    Removing: {
      invoke: {
        src: 'remove',
        input: ({ state }) => Removal.make(state),
        onDone: {
          branches: 'removed',
          declinable: true,
          resolve: (context) =>
            context.output.attempt === context.state.attempt
              ? context.select.idle()
              : context.decline(),
        },
        onFailure: {
          branches: 'removed',
          declinable: true,
          resolve: (context) =>
            context.error.removal.attempt === context.state.attempt
              ? context.select.refused({ data: { id: context.error.removal.id } })
              : context.decline(),
        },
      },
    },
    Refused: { on: { Remove: remove } },
  },
})

/** What every viewer reads: nothing happening, one Artifact being removed, or one refused. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Idle: {},
  Removing: { id: ArtifactId },
  Refused: { id: ArtifactId },
})
export type Reading = typeof Reading.Type

/** Session-owned: one for the app, read by every viewer. */
export const make = (services: Layer.Layer<Remover>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Removing'), ({ id }) => Reading.cases.Removing.make({ id })),
        Option.map(States.get(state, 'Refused'), ({ id }) => Reading.cases.Refused.make({ id })),
      ]),
      () => Reading.cases.Idle.make({}),
    )
  })
  return { ...atoms, reading, remove: Events.Remove }
}

/**
 * Whether Delete is held: while any deletion is on its way (one at a time; the machine refuses a
 * second press as well), and before the machine has started.
 */
export const isWaiting = Reading.isAnyOf(['Starting', 'Removing'])

/** The sentence beside this Artifact's actions when its last deletion was refused. */
export const refusalOf = (reading: Reading, id: ArtifactId): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Idle: () => Option.none(),
    Removing: () => Option.none(),
    Refused: (refused) =>
      refused.id === id ? Option.some('This wasn’t deleted. Try again.') : Option.none(),
  })
