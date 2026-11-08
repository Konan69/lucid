import { ThreadId, type ProjectId } from '@vivid/contracts'
import { sending, titleFromMessage } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { useMemo } from 'react'
import { change, changing } from './app'
import { live } from './live'
import { beginThread, useSending, warmConversation } from './sending'
import { router } from '../router'
import { scope } from './scope'

/**
 * The words a Thread was started with, while the Thread is being made. It is read from the
 * Thread's sending (`sending.ts`, `@vivid/state`), never kept beside it: the words wait in its
 * `Creating` state until the server has made the Thread, and stay in `Uncreated` when it did
 * not, to be sent again. Once the Thread is made they are an ordinary delivery, drawn and sent
 * like any other, and nothing is held here.
 *
 * - `Settled`: the Thread is made, or was not started on this page.
 * - `Sending`: the Thread is being made with these words.
 * - `Unsent`: making it failed or was stopped; the words wait to be sent again.
 */
export type FirstWords = Data.TaggedEnum<{
  Settled: {}
  Sending: Waiting
  Unsent: Waiting
}>
interface Waiting {
  readonly words: string
  readonly projectId: ProjectId | null
  readonly key: string
}
export const FirstWords = Data.taggedEnum<FirstWords>()
const SETTLED = FirstWords.Settled()

/** Read only the creation states. After creation, ordinary sending owns the same first row. */
const firstIn = (state: Option.Option<sending.SendingState>): FirstWords =>
  Option.match(state, {
    onNone: () => SETTLED,
    onSome: (at) => {
      const creating = sending.SendingStates.get(at, 'Creating')
      if (Option.isSome(creating)) {
        const { delivery, creation } = creating.value
        return FirstWords.Sending({
          words: delivery.words,
          key: delivery.key,
          projectId: creation.projectId,
        })
      }
      const uncreated = sending.SendingStates.get(at, 'Uncreated')
      if (Option.isSome(uncreated)) {
        const { delivery, creation } = uncreated.value
        return FirstWords.Unsent({
          words: delivery.words,
          key: delivery.key,
          projectId: creation.projectId,
        })
      }
      return SETTLED
    },
  })

/** Stable first-word presentation while the underlying machine state remains unchanged. */
export const useFirstWords = (id: ThreadId): FirstWords => {
  const state = useSending(id)
  return useMemo(() => firstIn(state), [state])
}

/** A successful creation remounts the conversation as before, after first words already appeared. */
export const useLanded = (id: ThreadId): boolean => sending.createdHere(useSending(id))

/**
 * Navigate at once with first words already in the shared owner. Every follow-up waits behind
 * creation and those words. Creation replay keeps the same Thread id after a lost receipt.
 */
export function startThread(message: string, projectId: ProjectId | null = scope.filing()) {
  const id = ThreadId.make(crypto.randomUUID())
  beginThread({
    creation: { id, title: titleFromMessage(message), projectId },
    delivery: { thread: id, key: crypto.randomUUID(), words: message, pictures: [] },
  })
  warmConversation(id)
  void router.navigate({ to: '/t/$id', params: { id } })
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
  const key = crypto.randomUUID()
  void change((client) =>
    client.CarryOnThread({ threadId: thread, body, key }).pipe(Effect.retry({ times: 1 })),
  )
}
