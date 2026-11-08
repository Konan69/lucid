import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { Owed, OwedId, OwedState } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { dayOf, thisReader, type Reader } from './when.js'

/**
 * What the Person is waiting on, as every surface draws it on the Feed: the records Vivid keeps
 * of who owes the Person what (`Owed`, `@vivid/contracts`), the words a row says about each, and
 * the press that closes one from its row.
 *
 * The list itself is a live query (`WatchOwed`): it only mirrors the server. Closing a record is
 * a press that asks the server, so it is a machine, one per record, after the Feed's own press
 * (`feed.ts` `PressMachine`). A record is closed for good once the server takes it (`Resolved` and
 * `Dropped` are terminal in the contract), so unlike a Feed card nothing ever brings a closed row
 * back except a press that did not get through.
 */

/** A record the list still shows: nobody has closed it. */
export type Waiting = Owed & {
  readonly state: typeof OwedState.cases.Open.Type | typeof OwedState.cases.Nudged.Type
}

const isWaiting = (record: Owed): record is Waiting =>
  OwedState.isAnyOf(['Open', 'Nudged'])(record.state)

/**
 * The records the Feed lists, in the server's order (open and nudged first, soonest due first).
 * Resolved and dropped records leave the list; the server keeps them so the same thing is not
 * tracked twice.
 */
export const waitingOf = (owed: ReadonlyArray<Owed>): ReadonlyArray<Waiting> =>
  owed.filter(isWaiting)

/** The last chase and how many there were, for a record Vivid has chased. */
export const nudgeOf = (record: Waiting) =>
  Option.liftPredicate(record.state, OwedState.guards.Nudged)

/** How the Person closes a record from its row: they have it, or they stopped caring. */
export const Closing = Schema.TaggedUnion({ Resolve: {}, Drop: {} })
export type Closing = typeof Closing.Type

/**
 * The words the record keeps for how it closed. The contract asks for them; a row press has no
 * sentence of the Person's, so it says where the decision was made. Vivid reads these when the
 * same thing comes up again.
 */
export const closingWords = Closing.match({
  Resolve: () => 'The Person marked it received on the Feed.',
  Drop: () => 'The Person dropped it on the Feed.',
})

/**
 * Names one press. The presser makes it, so a failed press pressed again is a new attempt, and an
 * answer about an earlier attempt can never finish a later one.
 */
export const AttemptId = Schema.String.pipe(Schema.brand('OwedAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** One press on one record, carried through every state of its delivery. */
const Delivery = Schema.Struct({ id: OwedId, closing: Closing, attempt: AttemptId })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

const sameDelivery = Schema.toEquivalence(Delivery)

/** The server did not take the close, or its answer was lost. The row comes back to be pressed. */
export class CloseRefused extends Schema.TaggedError<CloseRefused>()(
  'OwedCloseRefused',
  { id: OwedId },
  { title: 'OwedCloseRefused' },
) {}

/** A refusal that remembers which press it answers, so a stale one is declined. */
class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()(
  'OwedDeliveryRefused',
  { delivery: Delivery },
  { title: 'OwedDeliveryRefused' },
) {}

/** A surface owns how the server is asked: the RPC client it already holds. */
export interface ClosingService {
  readonly close: (delivery: Delivery) => Effect.Effect<void, CloseRefused>
}

export class Closer extends Context.Service<Closer, ClosingService>()('@vivid/state/owed/Closer') {}

/**
 * Where a press on a record stands. `Sending` takes no second press; `Sent` keeps the row folded
 * until the list drops the record; `Unsent` puts it back, saying so, to be pressed again.
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
  Close: { id: OwedId, closing: Closing, attempt: AttemptId },
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
 * One record's close. `Sending` is entered again from `Unsent`, so both outcomes carry the
 * delivery they answer and are declined when it is not the current one (the 0.46 queued-outcome
 * rule, `feed.ts` `PressMachine`).
 */
export const CloseMachine = Machine.make({
  id: 'OwedClose',
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

/** One record's atoms in the app registry, with the surface's way of asking the server. */
export const makeClose = (services: Layer.Layer<Closer>) =>
  AtomMachine.bind(Atom.runtime(services)).make(CloseMachine)
export type CloseAtoms = ReturnType<typeof makeClose>

/**
 * The words a row says about one record, said against the moment the page was opened.
 *
 * A deadline is a day in the Person's own zone: `track_owed` resolves "Friday" with the zone in
 * the Person's settings, so the row reads it on that calendar (`person`), never the device's. Read
 * on the device's, a Friday 23:00 deadline in Lagos said "Saturday" in a browser three hours
 * ahead. Where the device is somewhere the deadline falls on another day (`here`), the quiet line
 * also says when that is where the Person is now, so both zones are in front of them.
 */
export function makeOwedWords(person: Reader, here: Reader) {
  const weekday = new Intl.DateTimeFormat(person.locale, {
    timeZone: person.timeZone,
    weekday: 'long',
  })
  const dated = new Intl.DateTimeFormat(person.locale, {
    timeZone: person.timeZone,
    day: 'numeric',
    month: 'short',
  })
  const local = new Intl.DateTimeFormat(here.locale, {
    timeZone: here.timeZone,
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })
  /** Whole calendar days from `now` to `moment`: negative in the past. */
  const daysTo = (moment: number, now: number) => dayOf(moment, person).day - dayOf(now, person).day
  const plural = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`)

  /** A day as a row says it: today, tomorrow, a weekday this week, otherwise a date. */
  const dayWords = (moment: number, now: number) => {
    const days = daysTo(moment, now)
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    if (days > 1 && days < 7) return weekday.format(moment)
    return dated.format(moment)
  }

  /**
   * The row's time at rest: how late it is, when it is due, or, with no date, how long the
   * Person has been waiting. `late` is the one case drawn in the danger ink.
   */
  const timing = (record: Owed, now: number): { readonly words: string; readonly late: boolean } =>
    Option.match(Option.fromNullOr(record.due), {
      onSome: (due) => {
        const days = daysTo(due, now)
        return days < 0
          ? { words: `${plural(-days, 'day')} late`, late: true }
          : { words: dayWords(due, now), late: false }
      },
      onNone: () => {
        const days = Math.max(0, -daysTo(record.since, now))
        return { words: days === 0 ? 'Today' : plural(days, 'day'), late: false }
      },
    })

  /** A past moment for "last …": today, yesterday, a weekday within the week, otherwise a date. */
  const lastWords = (moment: number, now: number) => {
    const days = -daysTo(moment, now)
    if (days <= 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 7) return `on ${weekday.format(moment)}`
    return `on ${dated.format(moment)}`
  }

  const times = (count: number) => {
    if (count === 1) return 'once'
    if (count === 2) return 'twice'
    return `${count} times`
  }

  /**
   * The quiet line under a row: when and how often Vivid chased it, what it is stuck on, and
   * otherwise what happens next.
   */
  const detail = (record: Waiting, now: number): string => {
    const chased = Option.map(
      nudgeOf(record),
      ({ count, lastAt }) => `Chased ${times(count)}, last ${lastWords(lastAt, now)}.`,
    )
    const stuck = Option.map(Option.fromNullOr(record.blockedOn), (on) => `Stuck on ${on}.`)
    const next = Option.isSome(stuck)
      ? Option.none<string>()
      : Option.some(sentence(record.nextStep))
    const elsewhere = Option.map(
      Option.filter(
        Option.fromNullOr(record.due),
        (due) => dayOf(due, person).day !== dayOf(due, here).day,
      ),
      (due) => `That is ${local.format(due)} where you are now.`,
    )
    return [chased, stuck, next, elsewhere].flatMap((part) => Option.toArray(part)).join(' ')
  }

  return { timing, detail }
}
export type OwedWords = ReturnType<typeof makeOwedWords>

/**
 * What the Feed lists and the words its rows say. A deadline is a day in the Person's own zone,
 * so there is nothing to list until both the records and the Person's settings are here.
 */
export interface Owing {
  readonly records: ReadonlyArray<Waiting>
  readonly said: OwedWords
}

/** The Feed's waiting-on list from the live record list and the zone in the Person's settings. */
export const owingOf = (
  list: Option.Option<{ readonly owed: ReadonlyArray<Owed> }>,
  timeZone: Option.Option<string>,
): Option.Option<Owing> =>
  Option.map(Option.all([list, timeZone]), ([listed, zone]) => ({
    records: waitingOf(listed.owed),
    said: owedWordsIn(zone),
  }))

/** One sayer per Person zone: building `Intl` formatters is the expensive part of a row. */
const sayers = new Map<string, OwedWords>()

/**
 * The words for a Person whose settings name `timeZone`, read on this device. Both surfaces take
 * the zone from the Person's live settings (`Settings.timezone`), the one `track_owed` used.
 */
export const owedWordsIn = (timeZone: string): OwedWords => {
  const here = thisReader()
  const known = sayers.get(timeZone)
  if (known !== undefined) return known
  const made = makeOwedWords({ locale: here.locale, timeZone }, here)
  sayers.set(timeZone, made)
  return made
}

/** A step written without a full stop still reads as a sentence beside the others. */
const sentence = (words: string) =>
  /[.!?]$/u.test(words.trim()) ? words.trim() : `${words.trim()}.`

/**
 * The head of the Feed: how many people the Person is waiting on, then the one that matters most
 * now (the first in the server's order is the soonest due), said only when it is late or due
 * within a day. `None` when nothing is owed: the head then says the Feed's own standing.
 */
/** The head's sentence: a bold lead, then, when there is one, the record that matters most now. */
export interface Head {
  readonly lead: string
  readonly rest: Option.Option<string>
}

export const headOf = (
  waiting: ReadonlyArray<Waiting>,
  timing: (record: Owed, now: number) => { readonly words: string; readonly late: boolean },
  now: number,
): Option.Option<Head> =>
  Option.map(Option.fromUndefinedOr(waiting[0]), (first) => {
    const people = new Set(waiting.map((record) => record.from.trim().toLowerCase())).size
    const lead = people === 1 ? `${first.from} owes you.` : `${people} people owe you.`
    const when = timing(first, now)
    const soon =
      Option.isSome(Option.fromNullOr(first.due)) &&
      (when.late || when.words === 'Today' || when.words === 'Tomorrow')
    const rest = soon
      ? Option.some(
          when.late
            ? `${first.from} is ${when.words}.`
            : `${first.from}, due ${when.words.toLowerCase()}.`,
        )
      : Option.none<string>()
    return { lead, rest }
  })

/** How far back and ahead a row's track reaches, in days from now. */
const TRACK_BACK_DAYS = 14
const TRACK_AHEAD_DAYS = 6
const DAY_MS = 86_400_000

/** Where now sits on every track, from 0 to 1: the same place on each row. */
export const TRACK_NOW = TRACK_BACK_DAYS / (TRACK_BACK_DAYS + TRACK_AHEAD_DAYS)

/** A moment's place on a track, from 0 (its left end) to 1 (its right end), and whether it fell off. */
interface Placed {
  readonly at: number
  readonly clipped: boolean
}

/**
 * A record's time drawn as a line: from when the Person started waiting, past the last chase, to
 * the day it is due, on one window shared by every row, so "now" is the same place on each line
 * and the rows read together. A moment outside the window sits at the end it fell off, marked
 * `clipped` so the surface can fade that end instead of claiming a date it cannot show.
 */
export interface Track {
  readonly since: Placed
  readonly chased: Option.Option<Placed>
  readonly due: Option.Option<Placed>
  /** Past due: the line runs on from the due mark to now in the danger ink. */
  readonly late: boolean
}

export const trackOf = (record: Waiting, now: number): Track => {
  const span = TRACK_BACK_DAYS + TRACK_AHEAD_DAYS
  const place = (moment: number): Placed => {
    const days = (moment - now) / DAY_MS
    const clamped = Math.min(TRACK_AHEAD_DAYS, Math.max(-TRACK_BACK_DAYS, days))
    return { at: (clamped + TRACK_BACK_DAYS) / span, clipped: clamped !== days }
  }
  const due = Option.fromNullOr(record.due)
  return {
    since: place(record.since),
    chased: Option.map(nudgeOf(record), ({ lastAt }) => place(lastAt)),
    due: Option.map(due, place),
    late: Option.exists(due, (moment) => moment < now),
  }
}
