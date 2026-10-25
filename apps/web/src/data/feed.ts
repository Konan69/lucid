import { VividRpcClient } from '@vivid/client-runtime'
import { useAtomValue } from '@effect/atom-react'
import { FeedItem, type FeedCardId } from '@vivid/contracts'
import { feed } from '@vivid/state'
import { Effect, Layer, Option, Result } from 'effect'
import { Atom, AsyncResult } from 'effect/reactivity'
import { create } from 'zustand'
import { change } from './app'
import { live } from './live'
import { changing } from './app'
import { say } from './said'
import { engine } from './runtime'

/**
 * What the Person does to the Feed from this page, between doing it and the Feed's next answer.
 *
 * The Feed itself is the server's (`live.feed`): one item per background Thread, in the stage its
 * work is in. A press on a card's button asks something of Vivid in that Thread, and the Feed will
 * say what came of it (the item turns to `Working`, Vivid posts again, or it is `Settled`), but
 * not at once. Until it does, the card is folded away where it stood, so the press is answered on
 * the frame it happened in (`feed.Press`, `@vivid/state`).
 *
 * Each card owns a shared press machine. This adapter supplies only Flue and RPC delivery;
 * the machine owns the in-flight work, refusals, retries, and replacement by a newer post.
 */

type Presses = { readonly presses: ReadonlyMap<FeedCardId, feed.Press> }

/** Titles are notification context, not delivery state; the machine owns whether a send failed. */
const closing = new Map<FeedCardId, string>()

/** Flue owns message delivery and its idempotency receipt; RPC owns marking a card done. */
const sending = Layer.succeed(feed.Sending, {
  send: Effect.fn('Feed.send')(function* ({ card, thread, pressed }: feed.Delivery) {
    please()
    yield* feed.Settling.$match(pressed.how, {
      Said: ({ words, key }) =>
        engine
          .run(
            Effect.flatMap(VividRpcClient, (client) =>
              client.SendToThread({ threadId: thread, text: words, pictures: [], key }),
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Result.isSuccess(result) ? Effect.void : Effect.fail(new feed.SendRefused({ card })),
            ),
          ),
      Done: () =>
        Effect.gen(function* () {
          const title = Option.fromUndefinedOr(closing.get(card))
          closing.delete(card)
          const closed = yield* changing((client) => client.MarkFeedCard({ card, state: 'done' }))
          if (Result.isFailure(closed)) {
            Option.map(title, (words) => say(`“${words}” could not be closed just now.`))
            return yield* new feed.SendRefused({ card })
          }
          return undefined
        }),
    })
  }),
})

/** The registry holds machine references; every delivery state is read from those machines. */
const cards = Atom.keepAlive(Atom.make<ReadonlyMap<FeedCardId, feed.PressAtoms>>(new Map()))

/** Projects the machine atoms without copying their lifecycle into another store. */
const presses = Atom.make((get): Presses => {
  const held = new Map<FeedCardId, feed.Press>()
  for (const [card, machine] of get(cards)) {
    const result = get(machine.result)
    if (!AsyncResult.isSuccess(result)) continue
    Option.map(feed.pressOf(result.value), (press) => held.set(card, press))
  }
  return { presses: held }
})

/** Keeps the existing selector API while rerendering only when the atoms publish a change. */
export const usePresses = <Value>(select: (state: Presses) => Value): Value =>
  select(useAtomValue(presses))

/** The press on one card, when there is one. */
export const pressOn =
  (card: FeedCardId) =>
  (state: Presses): Option.Option<feed.Press> =>
    Option.fromUndefinedOr(state.presses.get(card))

/** A card's machine outlives a folded card or a route change, just as the live Feed does. */
const machineFor = (card: FeedCardId): feed.PressAtoms => {
  const known = engine.registry.get(cards)
  const existing = known.get(card)
  if (existing !== undefined) return existing
  const machine = feed.makePress(sending)
  engine.registry.set(cards, new Map(known).set(card, machine))
  engine.registry.mount(machine.snapshot)
  return machine
}

/** The bridge queues startup writes and the machine refuses duplicate presses before redraw. */
const press = (item: feed.Waiting, how: feed.Settling) => {
  const machine = machineFor(item.card)
  engine.registry.set(machine.send, feed.PressEvents.Press({ item, how }))
}

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
  press(item, feed.Settling.Said({ words, key: crypto.randomUUID() }))
}

/** Closes a card that asks nothing of the Person (it has no buttons): "Done". */
export function close(item: feed.Waiting, title: string) {
  closing.set(item.card, title)
  press(item, feed.Settling.Done())
}

/** Each post on a reused card gets its own seen report for this page. */
const reported = feed.seenReports()

/**
 * Reports the current post on a card once. A report that does not get through is tried again
 * the next time the card is in view.
 */
const reportSeen = (card: FeedCardId) => {
  const current = engine.registry.get(live.feed.atom)
  if (!AsyncResult.isSuccess(current)) return
  const item = current.value.items.find(
    (candidate): candidate is feed.Waiting =>
      FeedItem.guards.Waiting(candidate) && candidate.card === card,
  )
  if (item === undefined || item.seen || !reported.claim(item)) return
  void change(
    (client) => client.MarkFeedCard({ card, state: 'seen' }),
    () => live.feed.expect(feed.seenIn(card)),
  ).then((done) => {
    if (Result.isFailure(done)) reported.forget(item)
  })
}

/**
 * Whether an entry shows the whole card. A card that fits in the view counts once all of it is
 * in view. A card taller than the view can never be all in view, so it counts once it fills most
 * of the view: the observer speaks only at its thresholds (every hundredth of the card), and the
 * last one a tall card crosses can sit up to a hundredth of its height short of the edge, so the
 * bar is set at 85% of the view, which holds for a card up to fifteen views tall.
 */
const whole = (entry: IntersectionObserverEntry) => {
  if (entry.rootBounds === null) return entry.intersectionRatio >= 0.99
  if (entry.boundingClientRect.height <= entry.rootBounds.height)
    return entry.intersectionRatio >= 0.99
  return entry.intersectionRect.height >= entry.rootBounds.height * 0.85
}

/** Mounted cards remain enumerable after a report so later posts can be observed again. */
const cardOf = new Map<Element, FeedCardId>()

/**
 * The one watcher of every new card on the page. A card counts as looked at the first time all of
 * it has been in view while the page is in front; opening the Feed with a card below the fold
 * does not. Steps of a hundredth, so a card taller than the view still reports as it fills it.
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
      { threshold: Array.from({ length: 101 }, (_, step) => step / 100) },
    )
    // Hidden-tab entries are discarded above. Returning to the tab must request a fresh
    // intersection, as must a new post that reuses a mounted card and its stable ref.
    const reconsider = () => {
      if (document.visibilityState !== 'visible') return
      for (const element of cardOf.keys()) {
        made.unobserve(element)
        made.observe(element)
      }
    }
    document.addEventListener('visibilitychange', reconsider)
    engine.registry.subscribe(live.feed.atom, reconsider)
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
      cardOf.delete(element)
    }
  }
  refs.set(card, ref)
  return ref
}
