import { FeedItem, type FeedCardId, type FeedResponse } from '@vivid/contracts'
import { Data, Option, Schema } from 'effect'

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

export type Waiting = typeof FeedItem.cases.Waiting.Type
export type Working = typeof FeedItem.cases.Working.Type
export type Settled = typeof FeedItem.cases.Settled.Type

/** The three stages, each newest first, and how many things wait on the Person. */
export interface FeedView {
  readonly waiting: ReadonlyArray<Waiting>
  readonly working: ReadonlyArray<Working>
  readonly settled: ReadonlyArray<Settled>
}

/** Sorts the Feed's items by stage. The server already sends them newest first. */
export const feedView = (items: FeedResponse['items']): FeedView => ({
  waiting: items.filter(FeedItem.guards.Waiting),
  working: items.filter(FeedItem.guards.Working),
  settled: items.filter(FeedItem.guards.Settled),
})

/**
 * The line under the greeting: how many things wait on the Person, bold, then the rest in the
 * page's quiet ink. The design's own words ("4 things need you. The rest is handled.").
 */
export const standingOf = (waiting: number): { readonly lead: string; readonly rest: string } => {
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
  if (view.waiting.length > 0) return 'waiting'
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
export type Chosen = Readonly<Record<string, unknown>>

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
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return value.map(String).join(', ')
}

/** The words a choice holds, when it holds any. */
export const chosenWords = (chosen: Chosen, name: string): Option.Option<string> =>
  Option.filter(
    Option.map(readHeld(chosen[name]), (held) =>
      wordsOf(typeof held === 'object' && 'value' in held ? held.value : held),
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
export type Settling = Data.TaggedEnum<{
  /** `key` names this one delivery, so sending the same words again is not a second message. */
  Said: { readonly words: string; readonly key: string }
  Done: {}
}>
export const Settling = Data.taggedEnum<Settling>()

/** One press, as it was made: the post it answered (`Waiting.at`) and how it settles the card. */
export interface Pressed {
  readonly at: number
  readonly how: Settling
}

/**
 * Where a press on a card stands, between the press and the Feed's next answer. While `Sending`
 * the card takes no press; `Sent` keeps it folded until the Feed moves on (Vivid works, posts
 * again, or settles it); `Unsent` puts it back, saying so, to be pressed again.
 *
 * A press is about one post: when Vivid posts again (`at` moves), that is a new question and the
 * card is shown again, whatever became of the press.
 */
export type Press = Data.TaggedEnum<{
  Sending: Pressed
  Sent: Pressed
  Unsent: Pressed
}>
export const Press = Data.taggedEnum<Press>()

/** Whether a press is about this post and has not failed: then its card is folded away. */
export const folds = (item: Waiting, press: Option.Option<Press>): boolean =>
  Option.exists(press, (held) => !Press.$is('Unsent')(held) && held.at === item.at)

/** Whether a press about this post failed: its card is back, and says so. */
export const failed = (item: Waiting, press: Option.Option<Press>): boolean =>
  Option.exists(press, (held) => Press.$is('Unsent')(held) && held.at === item.at)

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
