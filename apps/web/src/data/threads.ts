import { ThreadId, type ProjectId } from '@vivid/contracts'
import { sending, titleFromMessage } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { useMemo } from 'react'
import { changing } from './app'
import { live } from './live'
import { beginThread, halted, sayAgain, sendingNow, useSending, warmConversation } from './sending'
import { router } from '../router'
import { scope } from './scope'

/** First-word presentation is a projection of the shared sending machine, never a second owner. */
export type FirstWords = Data.TaggedEnum<{
  /** Nothing is held: the Thread was not started on this page. */
  Settled: {}
  Sending: Waiting
  Unsent: Waiting
  /** The words are with Vivid. Held for as long as the page is open, so they keep their row. */
  Said: { readonly words: string }
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

/** The current first-word projection for code outside React. */
export const wordsFor = (id: ThreadId): FirstWords => firstIn(sendingNow(id))

/** Stable first-word presentation while the underlying machine state remains unchanged. */
export const useFirstWords = (id: ThreadId): FirstWords => {
  const state = useSending(id)
  return useMemo(() => firstIn(state), [state])
}

/** A successful creation remounts the conversation as before, after first words already appeared. */
export const useLanded = (id: ThreadId): boolean => sending.createdHere(useSending(id))

export const firstWords = {
  halt: halted,
  again: sayAgain,
}

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
