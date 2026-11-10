import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * Handing a file Vivid made to another app: on a phone the file is downloaded and given to the
 * system's share sheet ("Open in", Save to Files, AirDrop), which takes a moment and can fail.
 *
 * It is session-owned, so a card in a Thread and the same Artifact's viewer read one answer: a
 * press while a file is on its way is not taken a second time, and the reason a file could not be
 * opened is said where the Person pressed. Each press carries its own attempt id and `Opening` is
 * entered again from `Failed`, so every outcome says the attempt it answers and is declined when
 * that is not the current one (`owed.ts`, the 0.46 queued-outcome rule).
 *
 * `key` names what is being opened (an Artifact and version), so each place on screen asks
 * whether the answer is about its own file.
 */

/** Names one press. The presser makes it; the outcome says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('OpeningAttemptId'))
export type AttemptId = typeof AttemptId.Type

/**
 * Where the file's bytes are: stored on the Person's server at a path (a file Vivid made), or
 * written here from text the app already holds (a document, shared as Markdown).
 */
export const Source = Schema.TaggedUnion({
  Stored: { path: Schema.String },
  Written: { text: Schema.String },
})
export type Source = typeof Source.Type

/** What is opened, as the surface finds its bytes and names the file. */
const Target = Schema.Struct({
  attempt: AttemptId,
  key: Schema.String,
  name: Schema.String,
  source: Source,
})
export type Target = typeof Target.Type

/** The file could not be fetched or handed on; `message` is a sentence the place can show. */
export class Unopened extends Schema.TaggedError<Unopened>()(
  'FileUnopened',
  { target: Target, message: Schema.String },
  { title: 'FileUnopened' },
) {}

/** The surface owns the download and the platform's share sheet. */
export interface OpeningService {
  readonly open: (target: Target) => Effect.Effect<void, Unopened>
}

export class Opener extends Context.Service<Opener, OpeningService>()(
  '@vivid/state/opening/Opener',
) {}

const States = Machine.state({
  states: {
    Idle: {},
    Opening: { fields: Target.fields },
    Failed: { fields: { key: Schema.String, message: Schema.String } },
  },
})

const Events = Machine.events({ Open: Target.fields })

const open = {
  target: 'Opening',
  data: ({ event }: { readonly event: Target }) => Target.make(event),
} as const

const machine = Machine.make({
  id: 'FileOpening',
  root: States,
  events: Events,
  branches: { opened: { idle: { target: 'Idle' }, failed: { target: 'Failed' } } },
  effects: {
    open: (target: Target) => Opener.use((service) => service.open(target)).pipe(Effect.as(target)),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: { on: { Open: open } },
    Opening: {
      invoke: {
        src: 'open',
        input: ({ state }) => Target.make(state),
        onDone: {
          branches: 'opened',
          declinable: true,
          resolve: (context) =>
            context.output.attempt === context.state.attempt
              ? context.select.idle()
              : context.decline(),
        },
        onFailure: {
          branches: 'opened',
          declinable: true,
          resolve: (context) =>
            context.error.target.attempt === context.state.attempt
              ? context.select.failed({
                  data: { key: context.error.target.key, message: context.error.message },
                })
              : context.decline(),
        },
      },
    },
    Failed: { on: { Open: open } },
  },
})

/** What every place reads: nothing happening, a file on its way, or why one did not open. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Idle: {},
  Opening: { key: Schema.String },
  Failed: { key: Schema.String, message: Schema.String },
})
export type Reading = typeof Reading.Type

/** Session-owned: one for the app, read by every card and viewer. */
export const make = (services: Layer.Layer<Opener>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Opening'), ({ key }) => Reading.cases.Opening.make({ key })),
        Option.map(States.get(state, 'Failed'), ({ key, message }) =>
          Reading.cases.Failed.make({ key, message }),
        ),
      ]),
      () => Reading.cases.Idle.make({}),
    )
  })
  return { ...atoms, reading, open: Events.Open }
}

/** Whether this file is on its way to another app: its control is held, and the machine refuses. */
const isOpening = (reading: Reading, key: string) =>
  Reading.match(reading, {
    Starting: () => true,
    Idle: () => false,
    Opening: (opening) => opening.key === key,
    Failed: () => false,
  })

/** Why this file did not open, when the last press on it did not. */
export const failureOf = (reading: Reading, key: string): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Idle: () => Option.none(),
    Opening: () => Option.none(),
    Failed: (failed) => (failed.key === key ? Option.some(failed.message) : Option.none()),
  })

/**
 * Whether any file is on its way. One share sheet is shown at a time, so every Open is held while
 * one is, and the machine refuses a second press as well.
 */
export const isWaiting = Reading.isAnyOf(['Starting', 'Opening'])
