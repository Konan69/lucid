import { createFlueClient, type FlueConversationMessage } from '@flue/sdk'
import { ThreadId, type CarryOnRequest, type ProjectId } from '@vivid/contracts'
import { saysWords, titleFromMessage, withFirst } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { create } from 'zustand'
import { act } from './app'
import { changing, live } from './live'
import { engine } from './runtime'
import { router } from '../router'
import { scope } from './scope'

/**
 * The words a Thread was started with, from the moment the Person sent them until the
 * conversation itself can show them.
 *
 * The Thread screen opens before the words are sent, so that the Person is looking at their Thread
 * at once. At that moment the conversation does not exist yet, and its observer is told so and
 * stops looking. Without this hand-off the screen stayed empty until a reload. So the words are
 * held here, drawn from here while they travel, and when they land the screen is told to observe
 * the conversation afresh. If they do not land they stay here, unsent, to be sent again; they are
 * never dropped.
 *
 * Once they have landed they are still held (`Said`), and drawn until the conversation shows them
 * itself (`withFirst`, `@vivid/state`), under the one key (`standInOf`). Until 16 October 2026
 * they were let go at landing: the screen observed afresh, had no history yet, and for that round
 * trip drew "Opening the thread…" where the Person's words had just been (0.2 to 0.9 s on
 * production). The phone has held them this way since 7 October (`apps/mobile/src/data/first.ts`).
 *
 * `key` names the one delivery these words are, to the server. It is made once, when the Person
 * sends them (`startThread`), and stays with them until they have landed. The server admits a
 * message under its key and makes a key of its own for a message that has none, so first words
 * sent again without one were a second Message and a second Run whenever the first answer had
 * only been lost on the way back. They used to be sent with none.
 */
export type FirstWords = Data.TaggedEnum<{
  /** Nothing is held: the Thread was not started on this page. */
  Settled: {}
  Sending: Waiting
  Unsent: Waiting
  /** The words are with Vivid. Held for as long as the page is open, so they keep their row. */
  Said: { readonly words: string }
}>
/** First words that have not landed: what they are, where they are filed, and their delivery. */
interface Waiting {
  readonly words: string
  readonly projectId: ProjectId | null
  readonly key: string
}
export const FirstWords = Data.taggedEnum<FirstWords>()

// One object for every Thread with nothing held: the store compares what a screen selected with
// `Object.is`, and a new `Settled` each time would read as a change.
const SETTLED = FirstWords.Settled()
// Threads this page has made, so sending again after a failed send does not make one twice. It
// is the sender's own record and nothing is drawn from it, so it is not in the store.
const made = new Set<ThreadId>()

interface Held {
  /** Where each Thread's first words stand, for the Threads started on this page. */
  readonly held: ReadonlyMap<ThreadId, FirstWords>
}

/**
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * The map and the set are replaced, never changed in place, so a selector sees each move.
 */
export const useFirstWords = create<Held>()(() => ({ held: new Map() }))

/** Where a Thread's first words stand. The same object until they move. */
export const wordsFor =
  (id: ThreadId) =>
  (state: Held): FirstWords => {
    const standing = state.held.get(id)
    return standing === undefined ? SETTLED : standing
  }

const stand = (id: ThreadId, standing: FirstWords) =>
  useFirstWords.setState((was) => ({ held: new Map(was.held).set(id, standing) }))

/**
 * The first words as the conversation draws a Person's own message, while they travel and after
 * they are with Vivid, under the key the conversation's own message takes when it arrives
 * (`withFirst`, `@vivid/state`). None when there are none, or they did not arrive: words that did
 * not are drawn as not sent instead (`Thread.tsx`).
 */
export const standInOf = (
  id: ThreadId,
  first: FirstWords,
): Option.Option<FlueConversationMessage> =>
  FirstWords.$match(first, {
    Settled: () => Option.none(),
    Unsent: () => Option.none(),
    Sending: ({ words }) => Option.some(spoken(id, words)),
    Said: ({ words }) => Option.some(spoken(id, words)),
  })

/**
 * A Thread's conversation as it is drawn: with its first words in it from the moment they were
 * sent, keeping their row when the conversation's own copy of them arrives (`withFirst`). The
 * observation the screen opens once they have landed has no history for a round trip, and they
 * are not taken away for it.
 *
 * Its history counts as read only once they have landed (`historyReady` and `Said`) and it holds a
 * Person's message saying those first words. Before, the conversation does not exist, and Flue
 * calls an absent conversation's history ready and empty (`local_observation`, `@flue/react`
 * 2.2.2); Flue also admits a message before it is in the conversation, so a history read just
 * after landing can still be without it; and a follow-up sent meanwhile is a Person's message too,
 * which must keep its own row and not take the first words'.
 */
export const saidWith = (
  id: ThreadId,
  first: FirstWords,
  messages: ReadonlyArray<FlueConversationMessage>,
  historyReady: boolean,
): ReadonlyArray<FlueConversationMessage> =>
  withFirst(standInOf(id, first), {
    messages,
    ready:
      historyReady &&
      FirstWords.$is('Said')(first) &&
      messages.some((message) => saysWords(message, first.words)),
  })

/** A Person's message saying `words`, under the key a Thread's first words keep. */
const spoken = (id: ThreadId, words: string): FlueConversationMessage => ({
  id: `first:${id}`,
  role: 'user',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text: words, state: 'done' }],
})

/**
 * Makes the Thread if this page has not yet, then sends its first words, recording where they
 * stand at each step. The Thread must exist before the gateway will take a message for it.
 */
const deliver = (id: ThreadId, waiting: Waiting) =>
  Effect.gen(function* () {
    const { words, projectId, key } = waiting
    stand(id, FirstWords.Sending(waiting))
    if (!made.has(id)) {
      const created = yield* changing((client) =>
        client.CreateThread({ id, title: titleFromMessage(words), projectId }),
      )
      if (Result.isFailure(created)) {
        stand(id, FirstWords.Unsent(waiting))
        return
      }
      made.add(id)
      // The screen asked for this Thread before it existed and was told there was no such Thread.
      // Now there is, so the question is asked again.
      engine.reopen()
    }
    // Flue's client answers with a Promise. Both of its endings are turned into a value here, so
    // this wait cannot reject: a send that did not go through is `false`, not a failure.
    const sent = yield* Effect.promise(() =>
      createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` })
        .send({ message: { kind: 'user', body: words }, idempotencyKey: key })
        .then(
          () => true,
          () => false,
        ),
    )
    if (sent) {
      // The screen observes the conversation afresh once it sees the words are with Vivid: the
      // observer that opened with it was told there was no conversation yet (`Thread.tsx`).
      stand(id, FirstWords.Said({ words }))
    } else {
      stand(id, FirstWords.Unsent(waiting))
    }
  })

export const firstWords = {
  /** Sends unsent first words again, as the delivery they already are. */
  again: (id: ThreadId) => {
    const standing = wordsFor(id)(useFirstWords.getState())
    if (FirstWords.$is('Unsent')(standing)) {
      void act(
        deliver(id, { words: standing.words, projectId: standing.projectId, key: standing.key }),
      )
    }
  },
}

/**
 * Starts a Thread with its first message: the path from the first screen, a suggestion, a
 * Project's "new thread" and a Library item's "ask about this".
 *
 * Nothing here waits. The Thread's id is made on this side, the Person is taken to the Thread at
 * once and reads their own words there from `firstWords`, and the Thread is created and the words
 * sent behind that. Pressing Enter and seeing nothing for the length of a round trip reads as the
 * app not having heard.
 *
 * Unless the caller names a Project, the Thread is filed in the one the Person is scoped to
 * (`scope.filing`): scoping to a Project means new work lands in it.
 */
export function startThread(message: string, projectId: ProjectId | null = scope.filing()) {
  const id = ThreadId.make(crypto.randomUUID())
  const waiting: Waiting = { words: message, projectId, key: crypto.randomUUID() }
  stand(id, FirstWords.Sending(waiting))
  void router.navigate({ to: '/t/$id', params: { id } })
  void act(deliver(id, waiting))
  return id
}

/**
 * Opens an empty Thread, for when the Person wants the page before the words. This describes the
 * opening; whoever calls it starts it, and reads where it is filed when it starts.
 */
export const openThread = (projectId: ProjectId | null = scope.filing()) =>
  Effect.gen(function* () {
    const id = ThreadId.make(crypto.randomUUID())
    const created = yield* changing((client) =>
      client.CreateThread({ id, title: 'New thread', projectId }),
    )
    if (Result.isSuccess(created)) void router.navigate({ to: '/t/$id', params: { id } })
    return created
  })

export { live }

/**
 * Tells Vivid to go on in a Thread once a card's wait is over ("GitHub is connected"). It is sent
 * as a `carry-on` signal (`CarryOnRequest`), which no surface draws, so it never reads as words
 * the Person said. It is tried twice, as a message is; when both fail the card is still the thing
 * the Thread waits on and offers its own Carry on (`ConnectionAction` in `screen/thread/Cards.tsx`).
 */
export const carryOn = (thread: ThreadId, body: string) => {
  const message = { kind: 'signal', type: 'carry-on', body } as const satisfies Omit<
    CarryOnRequest,
    'idempotencyKey'
  >
  const idempotencyKey = crypto.randomUUID()
  const client = createFlueClient({ url: `/api/vivid/${encodeURIComponent(thread)}` })
  const once = () => client.send({ message, idempotencyKey })
  void once()
    .catch(once)
    .catch(() => undefined)
}
