import type { Connection } from '@vivid/contracts'
import { Option } from 'effect'
import type { PressKey } from './integration'

/**
 * What a card in a Thread wants done once the account it asked for is connected by a press made
 * on that card: the Thread is carried on by itself. This is the bookkeeping of those wishes, as
 * pure steps over an immutable map; the integration flow (`screen/integration/flow.ts`) holds the
 * map and calls what `settled` hands back.
 *
 * A wish belongs to a card, and it is answered only by the press that carried that card:
 *
 * - It is left unbound (`leave`). A card that has to ask for a name first leaves its wish and
 *   opens the form; if the form is dismissed, no press ever carries the card, the wish is never
 *   bound, and nothing answers it. It used to be filed under the service, where an account added
 *   from the Integrations page minutes later answered it and a Thread carried on by itself.
 * - It is bound when the flow accepts a press that carries the card (`bind`), under what that
 *   press is filed as: the service it begins on, or the Integration it picks up. A card has one
 *   wish, so pressing it again, now as a pick-up of the account the first press began, moves the
 *   wish and leaves none behind under the service to be answered a second time.
 * - It is forgotten when the Person carries on by hand (`forget`), so a press that ends later
 *   does not say "carry on" twice.
 *
 * A wish carries on the Thread whose card was pressed, even when the Person has opened another
 * Thread since: the carry-on belongs to the Thread that asked, as on the web (`carryOnOnceReady`,
 * `apps/web/src/screen/thread/Cards.tsx`).
 */
export interface Wish {
  /** The moment it lapses, in ms since the epoch: the Person has moved on by then. */
  readonly until: number
  /** Told the account as the server said it stands, connected. */
  readonly go: (connected: Connection) => void
  /** What the press that carries the card is filed under, once the flow has accepted one. */
  readonly bound: Option.Option<PressKey>
}

/** Every wish that is waiting, by the card that left it (the tool call the card stands for). */
export type Wishes = ReadonlyMap<string, Wish>

/** A card's wish, unbound. It replaces whatever the card left before: a card has one wish. */
export const leave = (wishes: Wishes, card: string, wish: Pick<Wish, 'until' | 'go'>): Wishes =>
  new Map(wishes).set(card, { ...wish, bound: Option.none() })

/**
 * The flow accepted a press that carries this card, filed under `key`. A card that left no wish
 * (it lapsed and was answered, or was forgotten) binds nothing.
 */
export const bind = (wishes: Wishes, card: string, key: PressKey): Wishes => {
  const wish = wishes.get(card)
  return wish === undefined
    ? wishes
    : new Map(wishes).set(card, { ...wish, bound: Option.some(key) })
}

/** The card no longer wants it: the Person carried on by hand. */
export const forget = (wishes: Wishes, card: string): Wishes => {
  const rest = new Map(wishes)
  rest.delete(card)
  return rest
}

const boundTo = (wish: Wish, key: PressKey) => Option.contains(wish.bound, key)

/** The wishes that are not bound to `key`. */
const without = (wishes: Wishes, key: PressKey): Wishes =>
  new Map([...wishes].filter(([, wish]) => !boundTo(wish, key)))

/**
 * The press filed under `key` ended in a connected account. `call` are the wishes bound to it
 * that have not lapsed at `now`; `rest` is the map without any wish bound to it, lapsed or not,
 * so each is answered at most once.
 */
export const settled = (wishes: Wishes, key: PressKey, now: number) => ({
  call: [...wishes.values()].filter((wish) => boundTo(wish, key) && now <= wish.until),
  rest: without(wishes, key),
})

/** The press filed under `key` was refused: nothing was begun, so nothing is waited on. */
export const refused = (wishes: Wishes, key: PressKey): Wishes => without(wishes, key)
