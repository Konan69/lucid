import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { AnswerIntegrationInputRequest, Conflict, InputRequestId } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { ProductFailure } from './live.js'

/**
 * Answering an Integration's question from its banner over the composer, on web, desktop and
 * phone: Send with the form's values, or Skip. The fields themselves are plain state in the
 * banner (`form.ts` reads and checks them); what waits on the server is this machine.
 *
 * Built as `allowing.ts` and `handing.ts` are: one answer at a time for the session, in atoms the
 * app owns, so a banner that folds away while its answer is still out (the request's record moved
 * on) does not lose the refusal. The answer is `AnswerIntegrationInput`, never `AnswerInput`: the
 * server refuses an ordinary answer to an Integration's question (`apps/server/src/inputs/store.ts`).
 */

/** An answer the server did not take, with its words for the Person. */
export class Refused extends Schema.TaggedError<Refused>()(
  'IntegrationAnswerRefused',
  { id: InputRequestId, words: Schema.String },
  { title: 'IntegrationAnswerRefused' },
) {}

/** Each app sends the answer over its own authenticated connection and words its refusal. */
export interface AnsweringService {
  readonly answer: (request: AnswerIntegrationInputRequest) => Effect.Effect<void, Refused>
}

export class Answering extends Context.Service<Answering, AnsweringService>()(
  '@vivid/state/filling/Answering',
) {}

/**
 * - `Sending`: an answer is on its way; no other is taken until it ends.
 * - `Sent`: the server took it. That request is never waiting again, so its banner keeps its
 *   controls off until the request's record takes it away.
 * - `Refused`: the server did not take it, for `words`. The form is as the Person left it and may
 *   be sent again.
 */
const States = Machine.state({
  states: {
    Ready: {},
    Sending: { fields: { request: AnswerIntegrationInputRequest } },
    Sent: { fields: { id: InputRequestId } },
    Refused: { fields: { id: InputRequestId, words: Schema.String } },
  },
})
const Events = Machine.events({ Answer: { request: AnswerIntegrationInputRequest } })
const answer = {
  target: 'Sending',
  data: ({ event }: { readonly event: { readonly request: AnswerIntegrationInputRequest } }) => ({
    request: event.request,
  }),
} as const

const machine = Machine.make({
  id: 'IntegrationAnswer',
  root: States,
  events: Events,
  effects: {
    answer: (request: AnswerIntegrationInputRequest) =>
      Answering.use((service) => service.answer(request)),
  },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { Answer: answer } },
    Sending: {
      invoke: {
        src: 'answer',
        input: ({ state }) => state.request,
        onDone: { target: 'Sent', data: ({ state }) => ({ id: state.request.id }) },
        onFailure: {
          target: 'Refused',
          data: ({ error }) => ({ id: error.id, words: error.words }),
        },
      },
    },
    Sent: { on: { Answer: answer } },
    Refused: { on: { Answer: answer } },
  },
})

/** The banner's exhaustive reading, including startup before the machine takes an answer. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  Sending: { id: InputRequestId, skipped: Schema.Boolean },
  Sent: { id: InputRequestId },
  Refused: { id: InputRequestId, words: Schema.String },
})
export type Reading = typeof Reading.Type

/** Session-owned atoms outlive the banner that pressed. */
export const make = (services: Layer.Layer<Answering>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Sending'), ({ request }) =>
          Reading.cases.Sending.make({
            id: request.id,
            skipped: request.response.action !== 'accept',
          }),
        ),
        Option.map(States.get(state, 'Sent'), (held) => Reading.cases.Sent.make(held)),
        Option.map(States.get(state, 'Refused'), (held) => Reading.cases.Refused.make(held)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, answer: Events.Answer }
}

/**
 * Whether this banner's controls are off: before the machine starts, while any answer is on its
 * way, and once this request's answer was taken. The machine refuses a second answer too.
 */
export const isHeld = (reading: Reading, id: InputRequestId): boolean =>
  Reading.match(reading, {
    Starting: () => true,
    Ready: () => false,
    Sending: () => true,
    Sent: (sent) => sent.id === id,
    Refused: () => false,
  })

/** Which button sent the answer on its way for this request, so only that one says it is going. */
export const goingOn = (reading: Reading, id: InputRequestId): Option.Option<'Send' | 'Skip'> =>
  Reading.guards.Sending(reading) && reading.id === id
    ? Option.some(reading.skipped ? 'Skip' : 'Send')
    : Option.none()

/** What the refused request says over its banner; nothing on any other. */
export const refusalFor = (reading: Reading, id: InputRequestId): Option.Option<string> =>
  Reading.guards.Refused(reading) && reading.id === id ? Option.some(reading.words) : Option.none()

/**
 * Why the server did not take an answer, in the Person's words. A conflict is the request
 * answered or expired meanwhile; anything else did not arrive.
 */
export const refusedWords = (failure: ProductFailure): string =>
  failure instanceof Conflict
    ? 'This was already answered, so nothing changed.'
    : 'That did not go through. Try again.'
