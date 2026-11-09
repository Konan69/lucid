import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { Todo, TodoId, TodoState } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { dayOf, thisReader, type Reader } from './when.js'

/**
 * The Person's own to-do list, as every surface draws it on the Feed: the to-dos Vivid adds and
 * ticks off (`Todo`, `@vivid/contracts`), the words a row says about each, and the press that
 * closes one from its row.
 *
 * The list is a live query (`WatchTodos`): it only mirrors the server. Closing a to-do is a press
 * that asks the server, so it is a machine, one per to-do, built as the waiting-on list's close is
 * (`owed.ts` `CloseMachine`). `Done` and `Dropped` are terminal in the contract, so nothing brings
 * a closed row back except a press that did not get through.
 */

/** A to-do the list still shows: nobody has ticked it off or dropped it. */
export type Open = Todo & { readonly state: typeof TodoState.cases.Open.Type }

const isOpen = (todo: Todo): todo is Open => TodoState.guards.Open(todo.state)

/** The to-dos the Feed lists, in the server's order (soonest date first, undated last). */
export const openOf = (todos: ReadonlyArray<Todo>): ReadonlyArray<Open> => todos.filter(isOpen)

/** How the Person closes a to-do from its row: done, or no longer meant. */
export const Closing = Schema.TaggedUnion({ Complete: {}, Drop: {} })
export type Closing = typeof Closing.Type

/**
 * The reason a drop keeps. The contract asks for one; a row press has no sentence of the
 * Person's, so it says where the decision was made.
 */
export const DROPPED_WORDS = 'The Person took it off their list on the Feed.'

/**
 * Names one press. The presser makes it, so a failed press pressed again is a new attempt, and an
 * answer about an earlier attempt can never finish a later one.
 */
export const AttemptId = Schema.String.pipe(Schema.brand('TodoAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** One press on one to-do, carried through every state of its delivery. */
const Delivery = Schema.Struct({ id: TodoId, closing: Closing, attempt: AttemptId })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

const sameDelivery = Schema.toEquivalence(Delivery)

/** The server did not take the close, or its answer was lost. The row comes back to be pressed. */
export class CloseRefused extends Schema.TaggedError<CloseRefused>()(
  'TodoCloseRefused',
  { id: TodoId },
  { title: 'TodoCloseRefused' },
) {}

/** A refusal that remembers which press it answers, so a stale one is declined. */
class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()(
  'TodoDeliveryRefused',
  { delivery: Delivery },
  { title: 'TodoDeliveryRefused' },
) {}

/** A surface owns how the server is asked: the RPC client it already holds. */
export interface ClosingService {
  readonly close: (delivery: Delivery) => Effect.Effect<void, CloseRefused>
}

export class Closer extends Context.Service<Closer, ClosingService>()(
  '@vivid/state/todos/Closer',
) {}

/**
 * Where a press on a to-do stands. `Sending` takes no second press; `Sent` keeps the row folded
 * until the list drops the to-do; `Unsent` puts it back, saying so, to be pressed again.
 */
export const CloseStates = Machine.state({
  states: {
    Idle: {},
    Sending: { fields: Delivery.fields },
    Sent: { fields: Delivery.fields },
    Unsent: { fields: Delivery.fields },
  },
})
export type CloseState = Parameters<typeof CloseStates.matches>[0]

export const CloseEvents = Machine.events({
  Close: { id: TodoId, closing: Closing, attempt: AttemptId },
})

/** What a row reads: whether it is folded away, back with a failure, or untouched. */
export type Standing = 'shown' | 'folded' | 'failed'

export const standingOf = (state: CloseState): Standing => {
  if (CloseStates.matches(state, 'Unsent')) return 'failed'
  if (CloseStates.matches(state, 'Sending') || CloseStates.matches(state, 'Sent')) return 'folded'
  return 'shown'
}

const deliveryOf = (event: Delivery): Delivery => ({
  id: event.id,
  closing: event.closing,
  attempt: event.attempt,
})

/**
 * One to-do's close. `Sending` is entered again from `Unsent`, so both outcomes carry the
 * delivery they answer and are declined when it is not the current one (the 0.46 queued-outcome
 * rule, `owed.ts` `CloseMachine`).
 */
export const CloseMachine = Machine.make({
  id: 'TodoClose',
  root: CloseStates,
  events: CloseEvents,
  branches: { delivered: { sent: { target: 'Sent' }, unsent: { target: 'Unsent' } } },
  effects: {
    close: (delivery: Delivery) =>
      Closer.use((service) => service.close(delivery)).pipe(
        Effect.as(delivery),
        Effect.mapError(() => new DeliveryRefused({ delivery })),
      ),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: {
      on: { Close: { target: 'Sending', data: ({ event }) => deliveryOf(event) } },
    },
    Sending: {
      invoke: {
        src: 'close',
        input: ({ state }) => deliveryOf(state),
        onDone: {
          branches: 'delivered',
          declinable: true,
          resolve: (context) =>
            sameDelivery(context.output, deliveryOf(context.state))
              ? context.select.sent({ data: context.output })
              : context.decline(),
        },
        onFailure: {
          branches: 'delivered',
          declinable: true,
          resolve: (context) =>
            sameDelivery(context.error.delivery, deliveryOf(context.state))
              ? context.select.unsent({ data: context.error.delivery })
              : context.decline(),
        },
      },
    },
    Sent: {},
    Unsent: {
      on: { Close: { target: 'Sending', data: ({ event }) => deliveryOf(event) } },
    },
  },
})

/** One to-do's atoms in the app registry, with the surface's way of asking the server. */
export const makeClose = (services: Layer.Layer<Closer>) =>
  AtomMachine.bind(Atom.runtime(services)).make(CloseMachine)
export type CloseAtoms = ReturnType<typeof makeClose>

/**
 * When a row says a to-do is due, against the moment the page was opened, in the waiting-on
 * list's words (`owed.makeOwedWords`): today, tomorrow, a weekday this week, a date, or how many
 * days late. `None` for a to-do with no date, whose slot stays empty rather than inventing one.
 *
 * The reader's zone is the Person's, as for a deadline they wait on: `add_todo` resolves "Friday"
 * with the zone in their settings, so the row reads it on that calendar (`todoWordsIn`).
 */
export function makeTodoWords(reader: Reader) {
  const weekday = new Intl.DateTimeFormat(reader.locale, {
    timeZone: reader.timeZone,
    weekday: 'long',
  })
  const dated = new Intl.DateTimeFormat(reader.locale, {
    timeZone: reader.timeZone,
    day: 'numeric',
    month: 'short',
  })
  const due = (
    todo: Open,
    now: number,
  ): Option.Option<{ readonly words: string; readonly late: boolean }> =>
    Option.map(Option.fromNullOr(todo.due), (moment) => {
      const days = dayOf(moment, reader).day - dayOf(now, reader).day
      if (days < 0) return { words: days === -1 ? '1 day late' : `${-days} days late`, late: true }
      if (days === 0) return { words: 'Today', late: false }
      if (days === 1) return { words: 'Tomorrow', late: false }
      if (days < 7) return { words: weekday.format(moment), late: false }
      return { words: dated.format(moment), late: false }
    })
  return { due }
}
export type TodoWords = ReturnType<typeof makeTodoWords>

/** One sayer per Person zone: building `Intl` formatters is the expensive part of a row. */
const sayers = new Map<string, TodoWords>()

/** The words for a Person whose settings name `timeZone`, in this device's language. */
export const todoWordsIn = (timeZone: string): TodoWords => {
  const known = sayers.get(timeZone)
  if (known !== undefined) return known
  const made = makeTodoWords({ locale: thisReader().locale, timeZone })
  sayers.set(timeZone, made)
  return made
}
