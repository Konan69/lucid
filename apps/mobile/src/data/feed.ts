import { useAtomValue } from '@effect/atom-react'
import type { FeedCardId } from '@vivid/contracts'
import { feed } from '@vivid/state'
import { Effect, Layer, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { confirm } from './haptics'
import type { LiveData } from './live'
import { say } from './threads'

type Presses = { readonly presses: ReadonlyMap<FeedCardId, feed.Press> }
type Pleased = { readonly pleased: boolean }

/** Each session's registry owns its card machines, including when the Feed screen is covered. */
const cards = Atom.keepAlive(Atom.make<ReadonlyMap<FeedCardId, feed.PressAtoms>>(new Map()))

/** Read the machines directly, so completion never copies a lifecycle into a second store. */
const presses = Atom.make((get): Presses => {
  const held = new Map<FeedCardId, feed.Press>()
  for (const [card, machine] of get(cards)) {
    const result = get(machine.result)
    if (!AsyncResult.isSuccess(result)) continue
    Option.map(feed.pressOf(result.value), (press) => held.set(card, press))
  }
  return { presses: held }
})

/** Read the shared press machines through the screen's existing selector contract. */
export const usePresses = <Value>(select: (state: Presses) => Value): Value =>
  select(useAtomValue(presses))

/** The press on one card, when this session holds one. */
export const pressOn =
  (card: FeedCardId) =>
  (state: Presses): Option.Option<feed.Press> =>
    Option.fromUndefinedOr(state.presses.get(card))

/** A new accepted press restarts this timer; disposing the session cancels it. */
const pleasing = Atom.keepAlive(Atom.fn(() => Effect.sleep('3500 millis')))

/** Vivid stays pleased for 3500 ms after an accepted press, across screen changes. */
export const usePleased = <Value>(select: (state: Pleased) => Value): Value =>
  select({ pleased: useAtomValue(pleasing).waiting })

/** Vivid is pleased for a moment: after a card is settled, or a record of what is owed closed. */
export const please = (data: LiveData): void => data.registry.set(pleasing, undefined)

/**
 * Supply only the phone's existing transports. The shared machine owns duplicate presses,
 * retry keys and late receipts; a refused transport becomes its Unsent state.
 */
const sending = (data: LiveData) =>
  Layer.succeed(feed.Sending, {
    send: Effect.fn('Feed.send')(function* ({ card, thread, pressed }: feed.Delivery) {
      confirm()
      please(data)
      const sent = yield* feed.Settling.$match(pressed.how, {
        // `say` is an Effect that answers with how the delivery went, never failing itself.
        Said: ({ words, key }) =>
          Effect.map(say(data, { id: thread, body: words, key, pictures: [] }), Result.isSuccess),
        Done: () =>
          Effect.map(
            Effect.promise(() =>
              data.change((client) => client.MarkFeedCard({ card, state: 'done' })),
            ),
            Result.isSuccess,
          ),
      })
      if (!sent) return yield* new feed.SendRefused({ card })
    }),
  })

/** A card keeps one machine for this session; registry disposal ends all its invoked work. */
const machineFor = (data: LiveData, card: FeedCardId): feed.PressAtoms => {
  const known = data.registry.get(cards)
  const existing = known.get(card)
  if (existing !== undefined) return existing
  const machine = feed.makePress(sending(data))
  data.registry.set(cards, new Map(known).set(card, machine))
  data.registry.mount(machine.snapshot)
  return machine
}

/** The bridge queues startup writes and the machine refuses duplicate presses before redraw. */
const press = (data: LiveData, item: feed.Waiting, how: feed.Settling): void => {
  const machine = machineFor(data, item.card)
  data.registry.set(machine.send, feed.PressEvents.Press({ item, how }))
}

/** Say the card's filled-in button words in its Thread, reusing a failed delivery's key. */
export function answer(data: LiveData, item: feed.Waiting, words: string): void {
  press(data, item, feed.Settling.Said({ words, key: randomUUID() }))
}

/** Settle a card through the session's product transport and shared press machine. */
export function close(data: LiveData, item: feed.Waiting): void {
  press(data, item, feed.Settling.Done())
}

/** Seen reports belong to a session, so signing in again can report each post afresh. */
const reports = new WeakMap<LiveData, ReturnType<typeof feed.seenReports>>()

/**
 * Reports a card from the list's viewability event, once per post and session. A failed report is
 * forgotten so the next time it is fully in view can try again.
 */
export function markSeen(data: LiveData, item: feed.Waiting): void {
  let reported = reports.get(data)
  if (reported === undefined) {
    reported = feed.seenReports()
    reports.set(data, reported)
  }
  if (item.seen || !reported.claim(item)) return
  const card = item.card
  const held = reported
  void data
    .change(
      (client) => client.MarkFeedCard({ card, state: 'seen' }),
      () => data.live.feed.expect(feed.seenIn(card)),
    )
    .then((done) => {
      if (Result.isFailure(done)) held.forget(item)
    })
}
