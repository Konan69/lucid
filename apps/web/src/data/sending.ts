import { useAtomValue } from '@effect/atom-react'
import { ThreadAudience, type ThreadId } from '@vivid/contracts'
import {
  conversationIn,
  conversations,
  isLive,
  isTooLong,
  LiveState,
  liveStateOf,
  sending,
  type Following,
  type LiveQuery,
} from '@vivid/state'
import { Effect, Layer, Option } from 'effect'
import { start } from './app'
import { heldConversations } from './conversation'
import { kept } from './kept'
import { live } from './live'
import { engine } from './runtime'
import { shareLocation } from './locating'
import { recording } from './telemetry'

/**
 * A Thread's conversation and what is sent into it, as this page holds them.
 *
 * Both are the shared ones (`@vivid/state` `conversation.ts` and `sending.ts`), made here once
 * for the page's socket and registry: the conversation is a live query, and sending is the
 * Thread's machine, which draws the Person's words at once and keeps the ones that did not
 * arrive. The desktop app runs this same module.
 *
 * It is also where the page's held conversations are made (`heldConversations`,
 * `data/conversation.ts`): holding a Thread mounts its conversation and its machine in the
 * registry, so both are there, and current, before the Thread's screen is drawn and after it has
 * gone.
 */

/** Every Thread's conversation, one live query for each. */
const followed = conversations(engine)

/** A Thread's conversation: what its screen reads, and what is held open ahead of it. */
export const conversationOf = (id: ThreadId): LiveQuery<Following> => followed.get(id)

/** Where this browser keeps every Thread's unsent words between visits (`sending.Kept`). */
const UNSENT = 'vivid-unsent'

/**
 * One change to the kept unsent words. What the store holds is read back first, so words another
 * tab kept are not written over; a store that refuses leaves them in this page's memory only.
 */
const changeUnsent = (revise: (held: sending.Kept) => sending.Kept) =>
  Effect.sync(() => {
    const next = revise(sending.readKept(kept.read(UNSENT)))
    const text = sending.writeKept(next)
    if (Option.isSome(text)) kept.write(UNSENT, text.value)
    return next
  })

/** How this page hands a delivery to the server: `SendToThread` on its socket. */
const transport = sending.delivering(engine.run, recording)
const machines = sending.makeSending(
  Layer.succeed(sending.Delivering, {
    ...transport,
    // Reopen queries only after creation succeeds. The invoke then releases first words in order.
    create: (request) =>
      transport.create(request).pipe(Effect.tap(() => Effect.sync(() => engine.reopen()))),
  }),
  {
    registry: engine.registry,
    whereabouts: sending.whereaboutsOf(live.me.answers),
    change: changeUnsent,
    launch: start,
  },
)

/**
 * This page's conversations: the one used last and three before it. Each is a subscription on
 * the page's one socket, so holding one costs the browser no connection; it costs the server a
 * link of its own to the runtime, which is why they are four and not every Thread visited. A
 * conversation that is neither held nor being read is let go at once (`conversations`,
 * `@vivid/state`). Until 27 October 2026 a conversation was a stream of its own, and over
 * HTTP/1.1 (the development proxy) only the one used last could be kept: a browser allows six
 * connections to an origin across every tab.
 */
const held = heldConversations(3, (id) => {
  const query = conversationOf(id)
  const letGoOfWords = engine.registry.mount(query.atom)
  // The Thread's machine is held with its conversation, so words that did not arrive are still
  // there to send again when the Person comes back to a Thread they left.
  const letGoOfSending = engine.registry.mount(sending.stateOf(machines(id)))
  return {
    end: () => {
      letGoOfWords()
      letGoOfSending()
    },
    again: () => {
      // Only when it did end: a conversation that is being followed is current already, and
      // asking again would have the server send the whole of it for every hover. And not one
      // refused for its size, which is the same size at every asking.
      const now = liveStateOf(engine.registry.get(query.atom))
      if (LiveState.$is('Failed')(now) && !isTooLong(now)) engine.registry.refresh(query.atom)
    },
  }
})

/** Opens a Thread's conversation ahead of its screen. One already held is marked as used. */
export const warmConversation = held.warm

/**
 * The session ended (`data/ending.ts`): every conversation it held is let go, so nothing the
 * Person was shown is still held, or still arriving, in a signed-out page.
 */
export const forgetConversations = (): void => {
  held.forget()
  machines.forget(engine.registry)
}

/**
 * Opens a Thread's conversation again from nothing: the "Reconnect" under a conversation that
 * cannot be reached. What was drawn stays until the new link has said the conversation whole.
 */
export const reopenConversation = (id: ThreadId): void => {
  engine.registry.refresh(conversationOf(id).atom)
}

/** Where sending stands in a Thread. The component re-renders when its machine moves. */
export const useSending = (id: ThreadId): Option.Option<sending.SendingState> =>
  useAtomValue(sending.stateOf(machines(id)))

/**
 * What a Thread draws now of its conversation and of what this page sent into it
 * (`sending.drawing`), read from the page's own registry: what did not arrive, and what this
 * reading has seen of the deliveries held, which the Thread's sending is told with a send. It
 * is read here at the moment of a send and not handed in by the screen, which would have to
 * make its way of sending anew at every word that arrives. `sending` is whether a delivery is
 * with the server and unanswered.
 */
const drawnNow = (id: ThreadId) => {
  const reading = liveStateOf(engine.registry.get(conversationOf(id).atom))
  const detail = liveStateOf(engine.registry.get(live.thread.get(id).atom))
  const state = engine.registry.get(sending.stateOf(machines(id)))
  return {
    ...sending.drawing({
      messages: Option.match(conversationIn(reading), {
        onNone: () => [],
        onSome: (now) => now.messages,
      }),
      live: isLive(reading),
      sending: state,
      runs: LiveState.$is('Ready')(detail) ? detail.value.runs : [],
      // Whether words are drawn ahead does not change which of them the conversation has.
      ahead: LiveState.$is('Ready')(detail)
        ? ThreadAudience.guards.Private(detail.value.thread.audience)
        : sending.createdHere(state) || sending.isCreating(state),
    }),
    sending: sending.isWaiting(state),
  }
}

/**
 * Sends everything that did not arrive in a Thread again, each as the delivery it is. The
 * machine takes it whatever else is on its way (`sending.ts`).
 */
export const sayAgain = (id: ThreadId): void => {
  const drawn = drawnNow(id)
  sending.sendAgain(engine.registry, machines(id), {
    seen: drawn.seen,
  })
}

/**
 * Says something new in a Thread, as a delivery of its own. Words sent while others are
 * travelling wait behind them. A new Thread's first words are said this way too, once their
 * Thread has been made (`data/threads.ts`): they are a delivery like any other.
 */
export const say = (delivery: sending.Delivery): void => {
  // Vivid is about to answer: where the Person is now, while they share it (`locating.ts`).
  shareLocation()
  sending.send(engine.registry, machines(delivery.thread), {
    delivery,
    seen: drawnNow(delivery.thread).seen,
  })
}

/**
 * Tells a Thread's sending that the Person stopped Vivid: nothing that was waiting to be sent
 * from this page is sent after it (`SendingEvents.Stop`).
 */
export const halted = (id: ThreadId): void => sending.stopped(engine.registry, machines(id))

/** Start creation with first words already in their Thread's ordered sending owner. */
export const beginThread = (first: Parameters<typeof sending.begin>[2]): void => {
  shareLocation()
  sending.begin(engine.registry, machines(first.delivery.thread), first)
}
