import { createFlueClient } from '@flue/sdk'
import type { FeedCardId } from '@vivid/contracts'
import { feed } from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import { create } from 'zustand'
import { act, change } from './app'
import { changing, live } from './live'
import { say } from './said'

/**
 * What the Person does to the Feed from this page, between doing it and the Feed's next answer.
 *
 * The Feed itself is the server's (`live.feed`): one item per background Thread, in the stage its
 * work is in. A press on a card's button asks something of Vivid in that Thread, and the Feed will
 * say what came of it (the item turns to `Working`, Vivid posts again, or it is `Settled`), but
 * not at once. Until it does, the card is folded away where it stood, so the press is answered on
 * the frame it happened in (`feed.Press`, `@vivid/state`).
 *
 * Each press is held here, in a Zustand store as `data/threads.ts` holds a new Thread's first
 * words: set at the press and moved from inside the flow that sends it, never from React state
 * after a wait.
 */

type Presses = { readonly presses: ReadonlyMap<FeedCardId, feed.Press> }

export const usePresses = create<Presses>()(() => ({ presses: new Map() }))

const put = (card: FeedCardId, press: feed.Press) =>
  usePresses.setState((was) => ({ presses: new Map(was.presses).set(card, press) }))

/** The press on one card, when there is one. */
export const pressOn =
  (card: FeedCardId) =>
  (state: Presses): Option.Option<feed.Press> =>
    Option.fromUndefinedOr(state.presses.get(card))

/**
 * Vivid's face is pleased for a moment after a card is settled: the look `done` opens with
 * (`@vivid/marks` `life.ts`). A store with its own timer, like `writing` in `data/life.ts`: it
 * changes only at its two edges.
 */
const PLEASED_FOR_MS = 3500

export const usePleased = create(() => ({ pleased: false }))
let pleasedUntil: Option.Option<ReturnType<typeof setTimeout>> = Option.none()

const please = () => {
  Option.map(pleasedUntil, clearTimeout)
  pleasedUntil = Option.some(
    setTimeout(() => {
      pleasedUntil = Option.none()
      usePleased.setState({ pleased: false })
    }, PLEASED_FOR_MS),
  )
  usePleased.setState({ pleased: true })
}

/**
 * Says a card's button in its Thread, as the Person, through Flue's own client: the same send the
 * Thread screen and a new Thread's first words make (`data/threads.ts`). The words are the
 * button's with what the Person chose laid in (`feed.fill`).
 *
 * A press while one is on its way for the same post is not taken. The same words pressed again
 * after a failed send keep that send's key (`feed.pressKey`), so a send whose answer was only lost
 * is not said twice.
 */
export function answer(item: feed.Waiting, words: string) {
  const standing = pressOn(item.card)(usePresses.getState())
  if (feed.folds(item, standing)) return
  const key = feed.pressKey(item, standing, words, () => crypto.randomUUID())
  const held: feed.Pressed = { at: item.at, how: feed.Settling.Said({ words, key }) }
  put(item.card, feed.Press.Sending(held))
  please()
  void act(
    Effect.gen(function* () {
      // Flue's client answers with a Promise; both endings become a value, so this cannot fail.
      const sent = yield* Effect.promise(() =>
        createFlueClient({ url: `/api/vivid/${encodeURIComponent(item.thread)}` })
          .send({ message: { kind: 'user', body: words }, idempotencyKey: key })
          .then(
            () => true,
            () => false,
          ),
      )
      put(item.card, sent ? feed.Press.Sent(held) : feed.Press.Unsent(held))
    }),
  )
}

/** Closes a card that asks nothing of the Person (it has no buttons): "Done". */
export function close(item: feed.Waiting, title: string) {
  if (feed.folds(item, pressOn(item.card)(usePresses.getState()))) return
  const held: feed.Pressed = { at: item.at, how: feed.Settling.Done() }
  put(item.card, feed.Press.Sending(held))
  please()
  void act(
    Effect.gen(function* () {
      const closed = yield* changing((client) =>
        client.MarkFeedCard({ card: item.card, state: 'done' }),
      )
      put(item.card, Result.isSuccess(closed) ? feed.Press.Sent(held) : feed.Press.Unsent(held))
      if (Result.isFailure(closed)) say(`“${title}” could not be closed just now.`)
    }),
  )
}

/** Cards this page has said were looked at, so a card is reported once. */
const reported = new Set<FeedCardId>()

/**
 * Tells the server a card has been looked at, once. A report that does not get through is tried
 * again the next time the card is in view.
 */
const reportSeen = (card: FeedCardId) => {
  if (reported.has(card)) return
  reported.add(card)
  void change(
    (client) => client.MarkFeedCard({ card, state: 'seen' }),
    () => live.feed.expect(feed.seenIn(card)),
  ).then((done) => {
    if (Result.isFailure(done)) reported.delete(card)
  })
}

/**
 * Whether an entry shows the whole card: all of it is in view, or it is taller than the view and
 * fills it.
 */
const whole = (entry: IntersectionObserverEntry) =>
  entry.intersectionRatio >= 0.99 ||
  (entry.rootBounds !== null && entry.intersectionRect.height >= entry.rootBounds.height - 1)

/** Which card each watched element is. */
const cardOf = new WeakMap<Element, FeedCardId>()

/**
 * The one watcher of every new card on the page. A card counts as looked at the first time all of
 * it has been in view while the page is in front; opening the Feed with a card below the fold
 * does not. Steps of a twentieth, so a card taller than the view still reports as it fills it.
 * Made on first use: a module that builds an observer when it loads would need a browser to load.
 */
let watcher: Option.Option<IntersectionObserver> = Option.none()

const watcherOf = (): IntersectionObserver =>
  Option.getOrElse(watcher, () => {
    const made = new IntersectionObserver(
      (entries) => {
        if (document.visibilityState !== 'visible') return
        for (const entry of entries) {
          const card = cardOf.get(entry.target)
          if (card === undefined || !whole(entry)) continue
          made.unobserve(entry.target)
          reportSeen(card)
        }
      },
      { threshold: Array.from({ length: 21 }, (_, step) => step / 20) },
    )
    watcher = Option.some(made)
    return made
  })

/** One ref per card, made once: a new function each render would watch the element again. */
const refs = new Map<FeedCardId, (element: HTMLElement | null) => () => void>()

/**
 * The ref a new card is drawn with: watching starts when the element is in the document and stops
 * when it leaves (React 19 runs the function a ref returns when the element goes). It is an event
 * from the browser, not an effect that sets state.
 */
export const seenWhenShown = (card: FeedCardId) => {
  const made = refs.get(card)
  if (made !== undefined) return made
  const ref = (element: HTMLElement | null) => {
    if (element === null) return () => undefined
    cardOf.set(element, card)
    watcherOf().observe(element)
    return () => {
      watcherOf().unobserve(element)
    }
  }
  refs.set(card, ref)
  return ref
}
