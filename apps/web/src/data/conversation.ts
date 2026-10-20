import {
  createFlueClient,
  type AgentConversationObservation,
  type AgentConversationObservationSnapshot,
  type FlueClient,
  type FlueConversationMessage,
} from '@flue/sdk'
import type { ThreadId } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * A Thread's conversation, opened before its screen is drawn and kept open after it closes.
 *
 * The conversation is Flue's: its history is one request and what is said next arrives on a
 * stream, both begun by `client.observe()`. The Thread screen used to make a new client each time
 * it mounted, and the hook that reads it (`useFlueAgent`) begins observing in an effect: so every
 * visit to a Thread, the first and the fiftieth, drew the Thread with nothing in it, asked for
 * the whole history again, and showed it a round trip later. That is what made opening a Thread
 * slow.
 *
 * Here each Thread has one client whose `observe()` hands out one observation that is already
 * running. The router begins it when a pointer rests on a link to the Thread and when the Person
 * goes there (`routes/thread.tsx`), so the history is usually here before the screen is; and it
 * is kept when the screen goes, so coming back shows the conversation at once (`Idle` says how).
 *
 * Everything is Flue's public client (`createFlueClient`, `observe`, and the observation's own
 * `subscribe`, `refresh` and `close`): the client handed out is the real one with `observe`
 * answering from the observation held here. Nothing of the hook or the SDK is reached into.
 */
/** What this module uses of a Flue client: the one call it answers itself. */
type Observable = Pick<FlueClient, 'observe'>

interface Held<Client> {
  readonly client: Client
  /** The conversation as the held observation has it now. */
  readonly snapshot: () => AgentConversationObservationSnapshot
  /** Ends the real observation. Called once, when this conversation is let go. */
  readonly end: () => void
  /** Opens the real observation's stream again, from the history it has missed. */
  readonly catchUp: () => void
  /** How many screens are reading it now. One being read is never let go. */
  readers: number
}

/**
 * What a kept conversation that nobody is reading costs this page.
 *
 * - `streaming`: it stays open, its stream running, so coming back to it asks the server nothing.
 *   For a page whose connection carries many requests at once (HTTP/2 or later).
 * - `parked`: its stream is ended and what it had said is kept. Coming back draws those words at
 *   once and opens the conversation again behind them, one history request. For a page where each
 *   stream holds a connection of its own (HTTP/1.1): a browser gives one origin six connections
 *   across every tab, and six open streams leave none for anything else. Measured on the
 *   development server on 20 October 2026 with Flue's own client: with five conversations
 *   streaming a request was answered in about 350 ms, with six, seven or nine the next requests
 *   had no answer in 4 s (`artifacts/pending/proofs/snappy` in the coordinator's checkout).
 */
export type Idle = 'streaming' | 'parked'

/**
 * The open conversations of one page.
 *
 * `kept` is how many conversations nobody is reading are kept besides the one used last, which
 * always stays open: it is the one a screen is about to read (a screen asks for its client while
 * it renders and begins reading a moment later, in an effect), or the one the Person just left and
 * is likeliest to come back to. `idle` is how the others are kept. `connect` makes a Thread's real
 * client.
 */
export const makeConversations = <Client extends Observable>(
  kept: number,
  idle: Idle,
  connect: (id: ThreadId) => Client,
) => {
  /** Open conversations, the most recently used last: a `Map` keeps the order they were set in. */
  const open = new Map<ThreadId, Held<Client>>()
  /**
   * What parked conversations had said when their streams were ended, the most recently parked
   * last. A Thread opened again keeps its entry until its new observation has read the
   * conversation (`heard`), and is parked afresh when it is next let go.
   */
  const parked = new Map<ThreadId, ReadonlyArray<FlueConversationMessage>>()

  /** Keeps what a conversation being let go had said, when it had been read. */
  const park = (id: ThreadId, held: Held<Client>) => {
    const conversation = held.snapshot().conversation
    if (conversation === undefined) return
    parked.delete(id)
    parked.set(id, conversation.messages)
  }

  /**
   * Lets go of the conversations used longest ago that nobody is reading: down to `kept` of them
   * open when they stream, and none when they are parked; then forgets the oldest parked words
   * down to `kept`.
   */
  const trim = () => {
    const resting = [...open].slice(0, -1).filter(([, held]) => held.readers === 0)
    const streams = idle === 'streaming' ? kept : 0
    for (const [id, held] of resting.slice(0, Math.max(0, resting.length - streams))) {
      open.delete(id)
      if (idle === 'parked') park(id, held)
      held.end()
    }
    const away = [...parked.keys()].filter((id) => !open.has(id))
    for (const id of away.slice(0, Math.max(0, away.length - kept))) parked.delete(id)
  }

  const hold = (id: ThreadId): Held<Client> => {
    const real = connect(id)
    const observation = real.observe({ live: 'sse' })
    // An observation begins when it is first listened to. This listener is what begins it, and
    // what keeps it running between one screen leaving and the next arriving.
    const stop = observation.subscribe(() => undefined)
    const held: Held<Client> = {
      readers: 0,
      snapshot: () => observation.getSnapshot(),
      end: () => {
        stop()
        observation.close()
      },
      catchUp: () => observation.refresh(),
      client: {
        ...real,
        observe: (): AgentConversationObservation => {
          held.readers += 1
          // A conversation the server did not have yet is not asked about again by itself, and
          // a Thread started here is opened before its first words have made it
          // (`data/threads.ts`). The Thread screen is built again once they land and observes
          // afresh; with one observation held for all, afresh has to be asked for.
          //
          // Asking again does not change what the observation says until the answer is back: it
          // goes on saying "absent", which a reader takes as a conversation with nothing in it,
          // and the Thread drew its empty state for the length of that round trip. So until the
          // observation says something new, this reader is told the truth of the moment: it is
          // being read.
          //
          // The same holds for an observation that gave up with an error (the server restarting
          // for a deploy answers 503 for a moment). A screen used to get a new observation each
          // visit, so leaving a Thread and coming back was a fresh try; with one observation held
          // for all, the Thread would say "can't be reached" on every visit until it was let go.
          const stale = Option.filter(
            Option.some(observation.getSnapshot()),
            (was) => was.phase === 'absent' || was.phase === 'error',
          )
          if (Option.isSome(stale)) observation.refresh()
          const reading = Option.map(stale, (was): AgentConversationObservationSnapshot => ({
            ...was,
            phase: 'loading',
          }))
          let closed = false
          return {
            getSnapshot: () => {
              const now = observation.getSnapshot()
              return Option.match(reading, {
                onNone: () => now,
                // The very object it said before: the observation makes a new one when it speaks.
                onSome: (loading) => (Option.exists(stale, (was) => was === now) ? loading : now),
              })
            },
            subscribe: (listener) => observation.subscribe(listener),
            refresh: () => observation.refresh(),
            // A screen closing its observation only stops reading. The conversation stays open,
            // and is let go when enough others have been used since (`trim`).
            close: () => {
              if (closed) return
              closed = true
              held.readers -= 1
              trim()
            },
          }
        },
      },
    }
    return held
  }

  /** The conversation's entry, made on first use and moved to the most recently used end. */
  const touch = (id: ThreadId): Held<Client> => {
    const held = Option.getOrElse(Option.fromUndefinedOr(open.get(id)), () => hold(id))
    open.delete(id)
    open.set(id, held)
    trim()
    return held
  }

  return {
    /**
     * The client a Thread's screen reads its conversation through. Its `observe()` answers with
     * the conversation as it already stands when it was opened earlier, and begins it when it
     * was not. The same client for the same Thread for as long as it is open, which a hook that
     * builds its session from the client depends on.
     */
    of: (id: ThreadId): Client => touch(id).client,
    /**
     * What has been said in a Thread, when its conversation is open here and has been read, or was
     * parked. A screen's own reading of the conversation begins a moment after it is drawn (the
     * hook that reads it starts in an effect), and a parked one is read again from the server; so
     * for that first frame, or that round trip, it has nothing. This is what is already known, for
     * the screen to draw until its own reading catches up. It does not open anything or mark the
     * conversation as used.
     */
    heard: (id: ThreadId): Option.Option<ReadonlyArray<FlueConversationMessage>> =>
      Option.orElse(
        Option.map(
          Option.flatMap(Option.fromUndefinedOr(open.get(id)), (held) =>
            Option.fromUndefinedOr(held.snapshot().conversation),
          ),
          (conversation) => conversation.messages,
        ),
        () => Option.fromUndefinedOr(parked.get(id)),
      ),
    /** Opens a Thread's conversation ahead of its screen. One already open is marked as used. */
    warm: (id: ThreadId): void => {
      touch(id)
    },
    /**
     * Has every open conversation catch up: its stream is opened again and what was said while it
     * was cut arrives as history. Called when the page's socket opens again after a loss
     * (`link.reopened`), which a deploy or a changed network causes as surely as it cuts these
     * streams; left alone, a cut stream waits out Flue's ninety-second timer first.
     */
    catchUp: (): void => {
      for (const held of open.values()) held.catchUp()
    },
    /** Ends every conversation and lets it go. */
    forget: (): void => {
      for (const held of open.values()) held.end()
      open.clear()
      parked.clear()
    },
  }
}

/**
 * Whether this page reached its server over a connection that carries many requests at once
 * (HTTP/2 or later), as production does. Over HTTP/1.1, which is what the development proxy
 * speaks, a browser allows six connections to one origin across every tab, and each open
 * conversation is a stream that holds one (`Idle`). A page that cannot say is taken to be the
 * costly kind: parking costs one history request, streaming on a capped connection stalls every
 * request after it.
 */
const multiplexed = (): boolean => {
  if (!('PerformanceNavigationTiming' in globalThis)) return false
  const [page] = performance.getEntriesByType('navigation')
  return page instanceof PerformanceNavigationTiming && /^h[23]/u.test(page.nextHopProtocol)
}

/**
 * This page's conversations: three kept besides the last used, streaming where connections are
 * shared and parked where each stream is a connection of its own.
 */
const conversations = makeConversations(3, multiplexed() ? 'streaming' : 'parked', (id) =>
  createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` }),
)

export const conversationOf = conversations.of
export const catchUpConversations = conversations.catchUp
export const warmConversation = conversations.warm
export const heardIn = conversations.heard

/**
 * The session ended (`data/ending.ts`): every conversation it had open is ended and let go, so
 * nothing the Person was shown is still held, or still arriving, in a signed-out page.
 */
export const forgetConversations = conversations.forget
