import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  FeedCardId,
  FeedItem,
  ThreadId,
  FeedResponse as FeedResponseSchema,
} from '@vivid/contracts'
import { Context, Data, Effect, type Layer, Option, Predicate, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { devicesWaiting, type DeviceList, type DeviceWaiting } from './devices.js'
import type { FormState } from './display.js'

/**
 * The Feed as every surface draws it: Vivid's own work in background Threads, one item per
 * Thread (`FeedItem`, `@vivid/contracts`), sorted into what needs the Person, what Vivid is doing,
 * and what is handled. Web (`apps/web/src/screen/Feed.tsx`) and phone
 * (`apps/mobile/src/screen/Feed.tsx`) differ only in how they lay this out.
 *
 * The accepted design is the OpenUI media feed of 13 October 2026 (design v8, then v9 for the
 * buttons: "yh buttons are better"): a card says where it is from, what Vivid says, draws the
 * thing itself with the same renderer a reply uses, and ends in the card's own buttons.
 */

type FeedResponse = typeof FeedResponseSchema.Type

export type Waiting = typeof FeedItem.cases.Waiting.Type
export type Working = typeof FeedItem.cases.Working.Type
export type Settled = typeof FeedItem.cases.Settled.Type

/**
 * Which post a card shows, as a value that only changes when Vivid posts again or the work stops
 * on something new: the post itself and what the work is asking for. An Approval or a question
 * that arrives after the Person answered is a new thing to show, not part of the answered post.
 * Two identical posts in a row read as one: telling them apart needs a revision from the server. The server's `at` is not it: marking a
 * card seen moves `at` too (`FeedStore.mark` writes `updatedAt`), so a press compared by `at`
 * could be taken as answering a new post the moment the card was marked seen.
 */
export const revisionOf = (item: Waiting): string => JSON.stringify([item.post, item.asking])

/** The three stages, each newest first, and how many things wait on the Person. */
export interface FeedView {
  readonly computers: ReadonlyArray<DeviceWaiting>
  readonly waiting: ReadonlyArray<Waiting>
  readonly working: ReadonlyArray<Working>
  readonly settled: ReadonlyArray<Settled>
}

/** Sorts the Feed's items by stage. The server already sends them newest first. */
export const feedView = (
  items: FeedResponse['items'],
  devices: Option.Option<DeviceList>,
): FeedView => ({
  computers: Option.match(devices, { onNone: () => [], onSome: devicesWaiting }),
  waiting: items.filter(FeedItem.guards.Waiting),
  working: items.filter(FeedItem.guards.Working),
  settled: items.filter(FeedItem.guards.Settled),
})

/**
 * The line under the greeting: how many things wait on the Person, bold, then the rest in the
 * page's quiet ink. The design's own words ("4 things need you. The rest is handled.").
 */
export const standingOf = (waiting: number) => {
  if (waiting === 0) return { lead: 'Nothing needs you.', rest: '' }
  return {
    lead: waiting === 1 ? '1 thing needs you.' : `${waiting} things need you.`,
    rest: 'The rest is handled.',
  }
}

/**
 * The face at the head of the Feed, as one of Vivid's face states (`@vivid/marks` `life.ts`):
 * pleased for a moment after the Person settles a card, at work while any Run is going, asking
 * while something waits on the Person, otherwise at rest.
 */
export const feedFace = (
  view: FeedView,
  pleased: boolean,
): 'done' | 'working' | 'waiting' | 'idle' => {
  if (pleased) return 'done'
  if (view.working.length > 0) return 'working'
  if (view.waiting.length > 0 || view.computers.length > 0) return 'waiting'
  return 'idle'
}

/**
 * What the Person chose inside a card's display, and the words a card's button says with it.
 *
 * A card's buttons are the card's own, under the display, so the display only draws and lets the
 * Person choose. A button's words may name a choice: "Book $flight" says "Book Arik Air at 7:10"
 * once a flight is picked (`FeedAction`). The choices are OpenUI's renderer state, keyed `$name`:
 * the defaults the program declared (`ParseResult.stateDeclarations`), then what the Person
 * changed (`onStateUpdate`), whose values the renderer may hold bare or as a field (`{ value }`,
 * `unwrapFieldValue` in `@openuidev/react-lang` 1.0.0).
 */
export type Chosen = FormState

/** One value a choice can hold: a word, a number, a tick, or several picked from a list. */
const Plain = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
])
/** A value as the renderer keeps it: bare, or inside the field that holds it. */
const Held = Schema.Union([Plain, Schema.Struct({ value: Plain })])
const readHeld = Schema.decodeUnknownOption(Held)

/** A choice's value as words. A tick is "yes" or "no"; several picks are listed. */
const wordsOf = (value: typeof Plain.Type): string => {
  if (Predicate.isBoolean(value)) return value ? 'yes' : 'no'
  if (Predicate.isString(value) || Predicate.isNumber(value)) return String(value).trim()
  return value.map(String).join(', ')
}

/** The words a choice holds, when it holds any. */
export const chosenWords = (chosen: Chosen, name: string): Option.Option<string> =>
  Option.filter(
    Option.map(readHeld(chosen[name]), (held) =>
      wordsOf(Predicate.isObject(held) && 'value' in held ? held.value : held),
    ),
    (words) => words.length > 0,
  )

/** A `$name` in a button's words: OpenUI Lang's own spelling of a state variable. */
const NAMED = /\$[A-Za-z_][A-Za-z0-9_]*/gu

/**
 * A button's words with every `$name` replaced by what the Person chose under that name. A name
 * nothing was chosen under is left as written: it is Vivid's mistake to see, not one to hide.
 */
export const fill = (action: string, chosen: Chosen): string =>
  action.replace(NAMED, (name) => Option.getOrElse(chosenWords(chosen, name), () => name))

/** How a press settles a card: by saying its words in the card's Thread, or by closing it. */
const SettlingSchema = Schema.TaggedUnion({
  /** `key` names this delivery, so retrying the same words does not add another message. */
  Said: { words: Schema.String, key: Schema.String },
  Done: {},
})
export type Settling = typeof SettlingSchema.Type
export const Settling = Data.taggedEnum<Settling>()

/** One press, including the post it answered, survives every state of its delivery. */
export const Pressed = Schema.Struct({ revision: Schema.String, how: SettlingSchema })
export interface Pressed extends Schema.Schema.Type<typeof Pressed> {}

/**
 * Where a press on a card stands, between the press and the Feed's next answer. While `Sending`
 * the card takes no press; `Sent` keeps it folded until the Feed moves on (Vivid works, posts
 * again, or settles it); `Unsent` puts it back, saying so, to be pressed again.
 *
 * A press is about one post. When Vivid posts again, its revision changes and the card is shown
 * again, whatever became of the press.
 */
export type Press = Data.TaggedEnum<{
  Sending: Pressed
  Sent: Pressed
  Unsent: Pressed
}>
export const Press = Data.taggedEnum<Press>()

/** Whether a press is about this post and has not failed: then its card is folded away. */
export const folds = (item: Waiting, press: Option.Option<Press>): boolean =>
  Option.exists(press, (held) => !Press.$is('Unsent')(held) && held.revision === revisionOf(item))

/** Whether a press about this post failed: its card is back, and says so. */
export const failed = (item: Waiting, press: Option.Option<Press>): boolean =>
  Option.exists(press, (held) => Press.$is('Unsent')(held) && held.revision === revisionOf(item))

/**
 * The delivery key for a press: the failed press's own key when the same words are pressed again
 * after a send whose answer was lost, so they are not said twice; otherwise a new one.
 */
export const pressKey = (
  item: Waiting,
  standing: Option.Option<Press>,
  words: string,
  fresh: () => string,
): string =>
  Option.getOrElse(
    Option.flatMap(
      Option.filter(standing, () => failed(item, standing)),
      (held) =>
        Settling.$match(held.how, {
          Said: (said) => (said.words === words ? Option.some(said.key) : Option.none<string>()),
          Done: () => Option.none<string>(),
        }),
    ),
    fresh,
  )

/**
 * Seen delivery belongs to a post on a card. Both surfaces reserve the same identity before
 * sending, and release only a refused report so another viewability event can retry it. One
 * entry per card, holding the post last reported: a new post replaces it, so the record never
 * holds more than the cards on the Feed this session.
 */
export const seenReports = () => {
  const reported = new Map<FeedCardId, string>()
  return {
    /** Derived asks have no persisted post to mark. Reserve only posted cards before delivery. */
    claim: (item: Waiting): boolean => {
      if (item.post === null) return false
      const post = revisionOf(item)
      if (reported.get(item.card) === post) return false
      reported.set(item.card, post)
      return true
    },
    /** A refused report frees its card, unless a newer post has been claimed since. */
    forget: (item: Waiting): void => {
      if (reported.get(item.card) === revisionOf(item)) reported.delete(item.card)
    },
  }
}

/** The Feed with one card marked as looked at, as the server will say once it has heard. */
export const seenIn =
  (card: FeedCardId) =>
  (current: FeedResponse): FeedResponse => ({
    items: current.items.map((item) =>
      FeedItem.guards.Waiting(item) && item.card === card
        ? FeedItem.cases.Waiting.make({ ...item, seen: true })
        : item,
    ),
  })

/**
 * What a waiting card says when it has no post: the work stopped on an Approval or a question,
 * which in the background reaches the Person only here. Opening the Thread is how they answer.
 */
export const askedWords = (item: Waiting): string =>
  item.asking.includes('approval')
    ? 'Vivid wants to do something and needs your yes. Open it to decide.'
    : 'Vivid has a question for you. Open it to answer.'

/** The delivery authority a surface supplies; card identity stays explicit in every call. */
const Delivery = Schema.Struct({ card: FeedCardId, thread: ThreadId, pressed: Pressed })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

/** A send was refused or its receipt was lost. Retrying keeps its delivery identity. */
export class SendRefused extends Schema.TaggedError<SendRefused>()(
  'FeedSendRefused',
  { card: FeedCardId },
  { title: 'FeedSendRefused' },
) {}

/** A surface owns how words are delivered and how a card is marked done. */
export interface SendingService {
  readonly send: (delivery: Delivery) => Effect.Effect<void, SendRefused>
}

/** Sends words through Flue or marks a card done using the current surface's transport. */
export class Sending extends Context.Service<Sending, SendingService>()(
  '@vivid/state/feed/Sending',
) {}

/** Each card owns its delivery, independent of every other card and screen mount. */
export const PressStates = Machine.state({
  states: {
    Idle: {},
    Sending: { fields: Delivery.fields },
    Sent: { fields: Delivery.fields },
    Unsent: { fields: Delivery.fields },
  },
})
export type PressState = Parameters<typeof PressStates.matches>[0]

/** A press names the exact post and carries a fresh candidate key for a new delivery. */
export const PressEvents = Machine.events({
  Press: { item: FeedItem.cases.Waiting, how: SettlingSchema },
})

/** The screen-facing value is absent only before the card has been pressed. */
export const pressOf = (state: PressState): Option.Option<Press> =>
  Option.firstSomeOf([
    Option.map(PressStates.get(state, 'Sending'), ({ pressed }) => Press.Sending(pressed)),
    Option.map(PressStates.get(state, 'Sent'), ({ pressed }) => Press.Sent(pressed)),
    Option.map(PressStates.get(state, 'Unsent'), ({ pressed }) => Press.Unsent(pressed)),
  ])

/** Builds a delivery, preserving the key only for the same words retrying the same failed post. */
const deliveryOf = (
  event: { readonly item: Waiting; readonly how: Settling },
  standing: Option.Option<Press>,
): Delivery => ({
  card: event.item.card,
  thread: event.item.thread,
  pressed: Pressed.make({
    revision: revisionOf(event.item),
    how: Settling.$match(event.how, {
      Said: ({ words, key }) =>
        Settling.Said({ words, key: pressKey(event.item, standing, words, () => key) }),
      Done: () => Settling.Done(),
    }),
  }),
})

/** The invoked effect owns completion and failure; handlers never write a result after a wait. */
export const PressMachine = Machine.make({
  id: 'FeedPress',
  root: PressStates,
  events: PressEvents,
  branches: { pressed: { sending: { target: 'Sending' } } },
  effects: {
    send: (delivery: Delivery) => Sending.use((service) => service.send(delivery)),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: {
      on: {
        Press: { target: 'Sending', data: ({ event }) => deliveryOf(event, Option.none()) },
      },
    },
    Sending: {
      invoke: {
        src: 'send',
        input: ({ state }) => ({ card: state.card, thread: state.thread, pressed: state.pressed }),
        onDone: {
          target: 'Sent',
          data: ({ state }) => ({ card: state.card, thread: state.thread, pressed: state.pressed }),
        },
        onFailure: {
          target: 'Unsent',
          data: ({ state }) => ({ card: state.card, thread: state.thread, pressed: state.pressed }),
        },
      },
      // A newer post replaces this invocation. A receipt for the old post then has nowhere to land.
      on: {
        Press: {
          branches: 'pressed',
          declinable: true,
          reenter: true,
          resolve: (context) => {
            if (context.state.pressed.revision === revisionOf(context.event.item))
              return context.decline()
            return context.select.sending({ data: deliveryOf(context.event, Option.none()) })
          },
        },
      },
    },
    Sent: {
      on: {
        Press: {
          branches: 'pressed',
          declinable: true,
          resolve: (context) => {
            if (context.state.pressed.revision === revisionOf(context.event.item))
              return context.decline()
            return context.select.sending({ data: deliveryOf(context.event, Option.none()) })
          },
        },
      },
    },
    Unsent: {
      on: {
        Press: {
          target: 'Sending',
          data: ({ state, event }) => deliveryOf(event, Option.some(Press.Unsent(state.pressed))),
        },
      },
    },
  },
})

/** Creates one card's atoms in the app registry with the surface's delivery service. */
export const makePress = (services: Layer.Layer<Sending>) =>
  AtomMachine.bind(Atom.runtime(services)).make(PressMachine)
export type PressAtoms = ReturnType<typeof makePress>
