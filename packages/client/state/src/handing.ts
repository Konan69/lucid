import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  FillHandoffRequest,
  HandoffFieldResult,
  HandoffFormState,
  HandoffId,
  HandoffRequest,
  HandoffScreenState,
  type HandoffField,
  type PersonId,
} from '@vivid/contracts'
import { Array as Arr, Context, Effect, type Layer, Match, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { ProductFailure } from './live.js'

/**
 * The Person's side of a handoff: filling a step's fields, taking the screen, sending Vivid on, or
 * withdrawing it. What the step is and where it stands is the server's record, read live with the
 * Thread (`ThreadDetail.handoffs`); this machine only fronts the four calls, one at a time, so a
 * second press cannot send a fill twice or finish a step while its fill is still being typed.
 *
 * It is session owned, as `deciding.ts` is: the banner that pressed may fold away (the record
 * moved on) while the call is still out, and its refusal must still be said where the step is.
 *
 * A fill's values exist in `Sending` only, for the call that carries them. A refused fill keeps
 * which step it was for and what to say, never what was typed; the fields are filled again.
 */
export const Command = Schema.TaggedUnion({
  Fill: { request: FillHandoffRequest },
  Begin: { id: HandoffId },
  Complete: { id: HandoffId },
  Withdraw: { id: HandoffId },
})
export type Command = typeof Command.Type

/** The handoff a command is about. */
export const idOf = (command: Command): HandoffId =>
  Command.match(command, {
    Fill: ({ request }) => request.id,
    Begin: ({ id }) => id,
    Complete: ({ id }) => id,
    Withdraw: ({ id }) => id,
  })

/** A call the server refused or that did not arrive, with its words for the Person. */
export class Refused extends Schema.TaggedError<Refused>()(
  'HandoffCommandRefused',
  { id: HandoffId, words: Schema.String },
  { title: 'HandoffCommandRefused' },
) {}

/** Each app supplies its authenticated RPC connection and words its refusals. */
export interface CallingService {
  readonly call: (command: Command) => Effect.Effect<void, Refused>
}

export class Calling extends Context.Service<Calling, CallingService>()(
  '@vivid/state/handing/Calling',
) {}

const States = Machine.state({
  states: {
    Ready: {},
    Sending: { fields: { command: Command } },
    Refused: { fields: { id: HandoffId, words: Schema.String } },
  },
})
const Events = Machine.events({ Press: { command: Command } })
const press = {
  target: 'Sending',
  data: ({ event }: { readonly event: { readonly command: Command } }) => ({
    command: event.command,
  }),
} as const

/** One call at a time; `Sending` takes no press, so the banner's controls are refused there too. */
const machine = Machine.make({
  id: 'Handoff',
  root: States,
  events: Events,
  effects: { call: (command: Command) => Calling.use((service) => service.call(command)) },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Press: press } },
    Sending: {
      invoke: {
        src: 'call',
        input: ({ state }) => state.command,
        onDone: { target: 'Ready' },
        onFailure: {
          target: 'Refused',
          data: ({ state, error }) => ({ id: idOf(state.command), words: error.words }),
        },
      },
    },
    Refused: { on: { Press: press } },
  },
})

/** The screen's exhaustive reading. A fill being sent is said without its values. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Sending: { id: HandoffId, step: Schema.Literals(['Fill', 'Begin', 'Complete', 'Withdraw']) },
  Refused: { id: HandoffId, words: Schema.String },
})
export type Reading = typeof Reading.Type

/** Session-owned atoms outlive the banner that pressed, so a refusal is not lost with it. */
export const make = (services: Layer.Layer<Calling>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Sending'), ({ command }) =>
          Reading.cases.Sending.make({ id: idOf(command), step: command._tag }),
        ),
        Option.map(States.get(state, 'Refused'), (refused) => Reading.cases.Refused.make(refused)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, press: Events.Press }
}

/**
 * What to say when a call about a step did not go through. The server's own refusals are said as
 * they are; a Computer it could not reach says why; anything else is the connection.
 */
export const refusedWords = (failure: ProductFailure): string =>
  Match.value(failure).pipe(
    Match.tags({
      HandoffClosed: (refused) => refused.message,
      HandoffNotAddressee: (refused) => refused.message,
      Conflict: (refused) => refused.message,
      HandoffComputerUnavailable: (refused) => refused.reason,
      HandoffNotCleared: ({ labels }) =>
        `The Computer still shows what you typed in ${labels.join(', ')}. Leave that page on the screen, then try again.`,
    }),
    Match.orElse(() => 'Not sent. Try again.'),
  )

/** Every handoff control waits while any call is out; the machine refuses the press as well. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Sending'])

/** The refusal to say beside one step, when the last call refused was about it. */
export const refusalFor = (reading: Reading, id: HandoffId): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Ready: () => Option.none(),
    Sending: () => Option.none(),
    Refused: (refused) => (refused.id === id ? Option.some(refused.words) : Option.none()),
  })

/** Whether a step still waits on the Person: not finished and not withdrawn. */
export const isOpen = (handoff: HandoffRequest): boolean =>
  HandoffRequest.match(handoff, {
    Form: ({ state }) => HandoffFormState.isAnyOf(['Waiting', 'Applying', 'Ready'])(state),
    Screen: ({ state }) => HandoffScreenState.isAnyOf(['Waiting', 'Ready'])(state),
  })

/**
 * The step that is up over the composer: the oldest still open that this Person must do. The
 * server lets a Person have one open at a time, so it is the one; a step asked of somebody else is
 * never up here, the Thread says who it waits on.
 */
export const handoffUp = (
  handoffs: ReadonlyArray<HandoffRequest>,
  me: PersonId,
): Option.Option<HandoffRequest> =>
  Arr.findFirst(handoffs, (handoff) => isOpen(handoff) && handoff.askedOf.id === me)

/** A field's latest result, in the Person's words. */
export const resultWords = (result: HandoffFieldResult): string =>
  HandoffFieldResult.match(result, {
    Filled: () => 'Filled',
    Refused: ({ reason }) => {
      switch (reason) {
        case 'TargetChanged':
          return 'Not filled: the page changed'
        case 'TargetUnavailable':
          return 'Not filled: the field is not on the page'
        case 'UnsupportedField':
          return 'Not filled: this field can’t be typed into'
      }
    },
    OutcomeUnknown: () => 'May be filled. Check the screen',
  })

/**
 * The fields a fill is for: every field the first time, so each has a result, and afterwards only
 * those not filled, which the Person may fill again.
 */
export const fieldsToFill = (
  fields: ReadonlyArray<HandoffField>,
  state: HandoffFormState,
): ReadonlyArray<HandoffField> =>
  HandoffFormState.match(state, {
    Waiting: () => fields,
    Applying: () => [],
    Ready: ({ fields: receipts }) =>
      fields.filter((field) =>
        receipts.some(
          (receipt) =>
            receipt.fieldId === field.id && !HandoffFieldResult.guards.Filled(receipt.result),
        ),
      ),
    Completed: () => [],
    Withdrawn: () => [],
  })
