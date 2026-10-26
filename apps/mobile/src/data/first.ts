import type { FlueConversationMessage } from '@flue/sdk'
import type { ProjectId, ThreadId } from '@vivid/contracts'
import { Data, Effect, Option } from 'effect'
import type { Delivery } from './delivery'

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
 *   keep the key they were drawn under (`withFirst`, `@vivid/state`), which is what Flue's own hook does for the
 *   messages it sends (`converge`, `@flue/react`).
 */

/**
 * Where a Thread's first words stand.
 *
 * - `Sending`: on their way. The Thread is being made, or the words are being handed to it.
 * - `Unsent`: they did not arrive, and `why` is what to tell the Person. `born` says whether the
 *   Thread was made, which is where sending again starts from.
 * - `Said`: with Vivid. Kept, so the words keep their place in the list for as long as the Thread
 *   is on this phone's screen.
 */
export type First = Data.TaggedEnum<{
  Sending: { readonly start: Start }
  Unsent: { readonly start: Start; readonly born: boolean; readonly why: string }
  Said: { readonly start: Start }
}>
export const First = Data.taggedEnum<First>()

/** What a Thread is started with. `at` is when the words left the composer, in milliseconds. */
export interface Start {
  /** Raw draft text, kept separately from document references added to the delivered words. */
  readonly words: string
  readonly message: Pick<Delivery, 'words' | 'pictures'>
  /** The Project the Thread is filed in, when the menu was showing one. */
  readonly projectId: ProjectId | null
  readonly at: number
  /** Where the words were typed, so words that do not arrive can be put back there. */
  readonly place: string
}

/** The key the first words are drawn under, and the name of their one delivery to the server. */
export const firstKey = (id: ThreadId): string => `first:${id}`

/**
 * The first words of every Thread started in one workspace, as an external store. The shell makes
 * one beside what the first screen shows (`makeFront`), so it outlives the greeting that started
 * the Thread and the Thread's own screen: the send goes on whichever of them is drawn.
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
    /** Every Thread's first words. The same map until one of them changes. */
    all: () => firsts,
    of: (id: ThreadId): Option.Option<First> => Option.fromUndefinedOr(firsts.get(id)),
    put: (id: ThreadId, first: First) => {
      firsts = new Map(firsts).set(id, first)
      for (const listener of listeners) listener()
    },
  }
}

export type Firsts = ReturnType<typeof makeFirsts>

/**
 * How first words reach the server, and what becomes of them on this phone. The real one is
 * `firstWay` (`data/threads.ts`); it is named here so the order of a first send can be read and
 * tested without a server, a device store or a screen.
 *
 * `make` and `say` answer with why they did not go through, when they did not.
 */
export interface Way {
  readonly make: (id: ThreadId, start: Start) => Effect.Effect<Option.Option<string>>
  readonly say: (id: ThreadId, start: Start) => Effect.Effect<Option.Option<string>>
  /** The words did not arrive: they are the Person's again. */
  readonly returned: (start: Start) => void
  /** The words are with Vivid: nothing of them is left to send. */
  readonly taken: (start: Start) => void
}

/**
 * Makes the Thread when it has not been made, then hands it its first words, and records how far
 * that got. Sending again starts where the last attempt stopped: a Thread that was made is never
 * made twice, and the words go out under the Thread's own key (`firstKey`), so the server takes a
 * second attempt as the same delivery and never as a second message.
 */
export const deliver = Effect.fn('First.deliver')(function* (
  way: Way,
  firsts: Firsts,
  id: ThreadId,
  attempt: { readonly start: Start; readonly born: boolean },
) {
  const { start } = attempt
  firsts.put(id, First.Sending({ start }))
  const unsent = (born: boolean) => (why: string) => {
    way.returned(start)
    firsts.put(id, First.Unsent({ start, born, why }))
  }
  if (!attempt.born) {
    const refused = yield* way.make(id, start)
    if (Option.isSome(refused)) {
      unsent(false)(refused.value)
      return
    }
  }
  const refused = yield* way.say(id, start)
  if (Option.isSome(refused)) {
    unsent(true)(refused.value)
    return
  }
  way.taken(start)
  firsts.put(id, First.Said({ start }))
})

/** Starts a Thread with its first words. `firsts` says how it goes. */
export const begin = (way: Way, firsts: Firsts, id: ThreadId, start: Start): Effect.Effect<void> =>
  deliver(way, firsts, id, { start, born: false })

/** Sends first words that did not arrive again, from where they stopped. */
export const again = (way: Way, firsts: Firsts, id: ThreadId): Effect.Effect<void> =>
  Option.match(Option.filter(firsts.of(id), First.$is('Unsent')), {
    onNone: () => Effect.void,
    onSome: (unsent) => deliver(way, firsts, id, unsent),
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

/**
 * The first words as the conversation draws a Person's own message, before it has its own, under
 * the key they keep once it has (`withFirst`, `@vivid/state`). None for a Thread not started here.
 */
export const standInOf = (
  id: ThreadId,
  first: Option.Option<First>,
): Option.Option<FlueConversationMessage> =>
  Option.map(first, ({ start }) => ({
    id: firstKey(id),
    role: 'user',
    purpose: 'user',
    display: 'visible',
    parts: [
      { type: 'text', text: start.message.words, state: 'done' },
      ...start.message.pictures.map((picture) => ({
        type: 'file' as const,
        mediaType: picture.mimeType,
        url: `data:${picture.mimeType};base64,${picture.data}`,
        filename: picture.filename,
      })),
    ],
  }))
