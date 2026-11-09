import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { type ApprovalDecision, ApprovalId, DecideApprovalRequest } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { Refusal, refusalWords } from './responding.js'

/**
 * Deciding an Approval away from its Thread: from Needs you on the Feed and from Notifications,
 * on web and phone. The decision is the same `DecideApproval` the Thread sends, quoting the
 * digest of the record it was pressed on, so the server's digest and staleness checks (#167)
 * stand behind every surface alike. The Thread keeps its own banner over the composer
 * (`Allow.tsx`), which is drawn from the Thread's record and settles with it.
 *
 * Built as `deciding.ts` is for a computer's access: one decision at a time for the session,
 * held in atoms the app owns, so leaving the screen that pressed does not lose a refusal.
 */

/** A decision the server refused. Nothing ran; the Approval reads as the server now has it. */
export class Refused extends Schema.TaggedError<Refused>()(
  'ApprovalDecisionRefused',
  { id: ApprovalId, refusal: Refusal },
  { title: 'ApprovalDecisionRefused' },
) {}

/** Each app sends the decision over its own authenticated connection. */
export interface SendingService {
  readonly send: (request: DecideApprovalRequest) => Effect.Effect<void, Refused>
}

export class Sending extends Context.Service<Sending, SendingService>()(
  '@vivid/state/allowing/Sending',
) {}

/**
 * - `Sending`: a decision is on its way; no other is taken until it answers.
 * - `Sent`: the server took it. That Approval is never pending again, so every surface keeps it
 *   folded away until the live list it came from no longer has it.
 * - `Refused`: the server did not take it, for `refusal`.
 */
const States = Machine.state({
  states: {
    Ready: {},
    Sending: { fields: { request: DecideApprovalRequest } },
    Sent: { fields: { request: DecideApprovalRequest } },
    Refused: { fields: { request: DecideApprovalRequest, refusal: Refusal } },
  },
})
const Events = Machine.events({ Decide: { request: DecideApprovalRequest } })
const decide = {
  target: 'Sending',
  data: ({ event }: { readonly event: { readonly request: DecideApprovalRequest } }) => ({
    request: event.request,
  }),
} as const

const machine = Machine.make({
  id: 'ApprovalDecision',
  root: States,
  events: Events,
  effects: {
    send: (request: DecideApprovalRequest) => Sending.use((service) => service.send(request)),
  },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Decide: decide } },
    Sending: {
      invoke: {
        src: 'send',
        input: ({ state }) => state.request,
        onDone: { target: 'Sent', data: ({ state }) => ({ request: state.request }) },
        onFailure: {
          target: 'Refused',
          data: ({ state, error }) => ({ request: state.request, refusal: error.refusal }),
        },
      },
    },
    Sent: { on: { Decide: decide } },
    Refused: { on: { Decide: decide } },
  },
})

/** The screens' exhaustive reading, including startup before the machine takes a decision. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Sending: { request: DecideApprovalRequest },
  Sent: { request: DecideApprovalRequest },
  Refused: { request: DecideApprovalRequest, refusal: Refusal },
})
export type Reading = typeof Reading.Type

/** Session-owned atoms outlive the screen that pressed. */
export const make = (services: Layer.Layer<Sending>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Sending'), (held) => Reading.cases.Sending.make(held)),
        Option.map(States.get(state, 'Sent'), (held) => Reading.cases.Sent.make(held)),
        Option.map(States.get(state, 'Refused'), (held) => Reading.cases.Refused.make(held)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, decide: Events.Decide }
}

/** Every decision control waits while one is on its way, and before the machine has started. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Sending'])

/**
 * The decision on its way for this Approval, if one is: the control that sent it says so, and
 * only that one.
 */
export const sendingOn = (reading: Reading, id: ApprovalId): Option.Option<ApprovalDecision> =>
  Reading.guards.Sending(reading) && reading.request.id === id
    ? Option.some(reading.request.decision)
    : Option.none()

/** Whether this Approval was decided here: it stays folded until its list lets it go. */
export const sentOn = (reading: Reading, id: ApprovalId): boolean =>
  Reading.guards.Sent(reading) && reading.request.id === id

/** What the refused Approval says beside its controls; nothing on any other. */
export const refusalFor = (reading: Reading, id: ApprovalId): Option.Option<string> =>
  Reading.guards.Refused(reading) && reading.request.id === id
    ? Option.some(refusalWords[reading.refusal])
    : Option.none()
