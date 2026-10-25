import type { ConversationMessage, ProjectId, ThreadId } from '@vivid/contracts'
import { sending } from '@vivid/state'
import { Data, Effect, Equal, Option } from 'effect'
import type { Atom, AtomRegistry } from 'effect/reactivity'

/**
 * A Thread's first words, from the moment they leave the composer on the first screen until they
 * are with Vivid.
 *
 * The Thread used to take the greeting's place only once the server had both made it and taken
 * its first message. For those two calls the greeting stood still with the words gone from the
 * composer, and then the Thread arrived as an outline before its conversation: the owner saw it
 * flash, stick and break (7 October 2026) and asked for the first message to be mounted at once
 * and to rise into place, as T3 Code mobile does. There a message that is not yet with the server
 * is kept in an outbox and appended to the feed until the server echoes it
 * (`src/features/threads/pending-thread-feed.ts`, `appendPendingThreadMessages`), and it is
 * matched to its echo by one id, so the row that was drawn first is the row that stays.
 *
 * Vivid differs in two ways, and both are handled here:
 * - The Thread itself does not exist yet. It is made first, under an id chosen on the phone, and
 *   nothing asks the server about it until its first words are with Vivid (`First.Said`): a query
 *   for a Thread that is not there ends for good (`data/live.ts`).
 * - The conversation names a Person's message itself, so the echo has another id. The first words
 *   keep the key they were drawn under (`withFirst`), which is what a Thread's own sending does
 *   for the messages it sends (`saidWith`, `@vivid/state` `sending.ts`).
 */

/**
 * Where a Thread's first words stand.
 *
 * - `Sending`: on their way. The Thread is being made, or the words are being handed to it.
 * - `Unsent`: the receipt is unanswered, and `why` is what to tell the Person. The shared
 *   owner knows whether creation must be retried and retains all queued deliveries.
 * - `Said`: with Vivid. Kept, so the words keep their place in the list for as long as the Thread
 *   is on this phone's screen.
 */
export type First = Data.TaggedEnum<{
  Sending: { readonly start: Start }
  Unsent: { readonly start: Start; readonly why: string }
  Said: { readonly start: Start; readonly submission: Option.Option<string> }
}>
export const First = Data.taggedEnum<First>()

/** What a Thread is started with. `at` is when the words left the composer, in milliseconds. */
export interface Start {
  readonly words: string
  /** The Project the Thread is filed in, when the menu was showing one. */
  readonly projectId: ProjectId | null
  readonly at: number
  /** Where the words were typed, so words that do not arrive can be put back there. */
  readonly place: string
}

/** The key the first words are drawn under, and the name of their one delivery to the server. */
export const firstKey = (id: ThreadId): string => `first:${id}`

/**
 * The first screen keeps composer metadata and a cached projection of the shared machine.
 * Publications come only from that owner, including a later send that discards refused words.
 * The cached map gives useSyncExternalStore a stable snapshot between those publications.
 */
export function makeFirsts() {
  let firsts: ReadonlyMap<ThreadId, First> = new Map()
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    all: () => firsts,
    of: (id: ThreadId): Option.Option<First> => Option.fromUndefinedOr(firsts.get(id)),
    /** Follow this delivery's owner until it releases the first words and their metadata. */
    follow: (way: Way, id: ThreadId, start: Start) => {
      const atom = way.stateIn(id)
      const refresh = () => {
        const next = firstOf(way.registry.get(atom), firstKey(id), start, way.unanswered)
        if (Equal.equals(next, Option.fromUndefinedOr(firsts.get(id)))) return
        const changed = new Map(firsts)
        Option.match(next, {
          onNone: () => changed.delete(id),
          onSome: (first) => changed.set(id, first),
        })
        firsts = changed
        if (Option.isNone(next)) stop()
        for (const listener of listeners) listener()
      }
      const stop = way.registry.subscribe(atom, refresh)
      refresh()
    },
  }
}

export type Firsts = ReturnType<typeof makeFirsts>

/**
 * How first words reach the server, and what becomes of them on this phone. The real one is
 * `firstWay` (`data/threads.ts`); it is named here so the order of a first send can be read and
 * tested without a server, a device store or a screen.
 *
 * `begin` and `again` observe the shared owner after an explicit press. They never hand words
 * from a separate creation lifecycle into the sender.
 */
/** The shared owner's first-delivery outcome, translated to the phone's existing copy. */
export type FirstDelivery = Data.TaggedEnum<{
  Accepted: { readonly submission: Option.Option<string> }
  Uncreated: { readonly why: string }
  Unanswered: { readonly why: string }
}>
export const FirstDelivery = Data.taggedEnum<FirstDelivery>()

export interface Way {
  readonly registry: AtomRegistry.AtomRegistry
  readonly stateIn: (id: ThreadId) => Atom.Atom<Option.Option<sending.SendingState>>
  readonly unanswered: string
  readonly begin: (id: ThreadId, start: Start) => Promise<FirstDelivery>
  readonly again: (id: ThreadId, start: Start) => Promise<FirstDelivery>
  readonly returned: (start: Start) => void
  readonly taken: (start: Start) => void
}

/** The first delivery has exactly the standing its machine gives every other delivery. */
const firstOf = (
  state: Option.Option<sending.SendingState>,
  key: string,
  start: Start,
  unanswered: string,
): Option.Option<First> => {
  // Begin is already queued when this projection is installed. The machine's startup Idle
  // snapshot precedes that event, so creation is still pending until its barrier speaks.
  // Publishing those words immediately also keeps the screen from querying an uncreated Thread.
  if (!sending.createdHere(state) && !sending.isCreating(state))
    return Option.some(First.Sending({ start }))
  if (
    Option.isNone(sending.deliveryOf(state, key)) &&
    Option.isNone(sending.recognisedOf(state, key))
  )
    return Option.none()
  return Option.match(sending.admissionOf(state, key), {
    onNone: () => Option.map(sending.deliveryOf(state, key), () => First.Sending({ start })),
    onSome: (admitted) =>
      Option.some(
        sending.Admission.match<First>(admitted, {
          Accepted: ({ submission }) => First.Said({ start, submission }),
          Uncreated: ({ why }) =>
            First.Unsent({ start, why: Option.getOrElse(why, () => unanswered) }),
          Unanswered: () => First.Unsent({ start, why: unanswered }),
        }),
      ),
  })
}

/** Only composer handback follows the awaited answer; standing always comes from the machine. */
const record = (way: Way, start: Start, result: FirstDelivery): void =>
  FirstDelivery.$match(result, {
    Accepted: () => way.taken(start),
    Uncreated: () => way.returned(start),
    Unanswered: () => way.returned(start),
  })

/** Subscribe to the owner when starting first words, retaining only their composer metadata. */
export const begin = Effect.fn('First.begin')(function* (
  way: Way,
  firsts: Firsts,
  id: ThreadId,
  start: Start,
) {
  const sent = way.begin(id, start)
  firsts.follow(way, id, start)
  record(way, start, yield* Effect.promise(() => sent))
})

/** A stale retry has no work once the machine has released the original words. */
export const again = (way: Way, firsts: Firsts, id: ThreadId): Effect.Effect<void> =>
  Option.match(Option.filter(firsts.of(id), First.$is('Unsent')), {
    onNone: () => Effect.void,
    onSome: ({ start }) =>
      Effect.promise(() => way.again(id, start)).pipe(
        Effect.map((result) => record(way, start, result)),
      ),
  })

/**
 * The Thread these words were already started with from the same composer, when they are not yet
 * with Vivid. Sending them again is then that Thread's first message going on, never a second
 * Thread: the server has taken at most one delivery under that Thread's key (`firstKey`).
 */
export const startedWith = (
  firsts: ReadonlyMap<ThreadId, First>,
  words: string,
  place: string,
): Option.Option<ThreadId> =>
  Option.fromUndefinedOr(
    [...firsts].find(
      ([, first]) =>
        !First.$is('Said')(first) && first.start.words === words && first.start.place === place,
    ),
  ).pipe(Option.map(([id]) => id))

/** Whether the server may be asked about the Thread: it has no first words in doubt. */
export const isSettled = (first: Option.Option<First>): boolean =>
  Option.match(first, { onNone: () => true, onSome: First.$is('Said') })

/**
 * Whether first words still count as on their way to Vivid. They do from the send until the
 * Thread's own two sources, its conversation and its record, have both spoken (`spoken`): after
 * that, whether Vivid is working is theirs to say. Without the second half a Thread would stop
 * saying Vivid is thinking for the moment between the server taking the words and the Thread's
 * record arriving.
 */
export const isOnItsWay = (first: Option.Option<First>, spoken: boolean): boolean =>
  Option.exists(first, (value) =>
    First.$match(value, {
      Sending: () => true,
      Unsent: () => false,
      Said: () => !spoken,
    }),
  )

/** The first words as the conversation draws a Person's own message, before it has its own. */
const standIn = (id: ThreadId, start: Start): ConversationMessage => ({
  id: firstKey(id),
  role: 'user',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text: start.words, state: 'done' }],
})

/**
 * A first message keeps its original row only with admission proof. Private input keys also
 * cover a lost receipt. Shared dispatch keys identify no Person, so uncertain words stay held
 * beside canonical messages until a receipt can identify the submission.
 */
export const withFirst = (
  id: ThreadId,
  first: Option.Option<First>,
  messages: ReadonlyArray<ConversationMessage>,
  ownership: { readonly privateThread: boolean; readonly recognised: Option.Option<string> },
): ReadonlyArray<ConversationMessage> =>
  Option.match(first, {
    onNone: () => messages,
    onSome: (held) => {
      const key = firstKey(id)
      const submission = First.$match(held, {
        Said: (said) => said.submission,
        Sending: () => Option.none<string>(),
        Unsent: () => Option.none<string>(),
      })
      const admitted = messages.find(
        (message) =>
          message.submissionId !== undefined &&
          Option.contains(submission, message.submissionId) &&
          (message.purpose === 'user' ||
            (message.purpose === 'dispatch' &&
              message.signal !== undefined &&
              message.signal.tagName === 'message')),
      )
      const recognised = messages.find((message) =>
        Option.contains(ownership.recognised, message.id),
      )
      const privateEcho = ownership.privateThread
        ? messages.find(
            (message) =>
              message.role === 'user' && message.purpose === 'user' && message.key === key,
          )
        : undefined
      const echo = recognised ?? admitted ?? privateEcho
      // An accepted row is already supplied by the sending machine while placement is pending.
      // Recreating it here would restore a delivery withdrawn by an ended Run.
      if (echo === undefined) {
        if (First.$is('Said')(held)) return messages
        return [standIn(id, held.start), ...messages]
      }
      return messages.map((message) =>
        message === echo ? Object.assign({}, message, { id: key }) : message,
      )
    },
  })
