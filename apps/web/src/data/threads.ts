import { createFlueClient } from '@flue/sdk'
import { ThreadId, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Data, Result } from 'effect'
import { change, live } from './live'
import { engine } from './runtime'
import { Route, router } from './route'

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
 */
export type FirstWords = Data.TaggedEnum<{
  Settled: {}
  Sending: { readonly words: string; readonly projectId: ProjectId | null }
  Unsent: { readonly words: string; readonly projectId: ProjectId | null }
}>
export const FirstWords = Data.taggedEnum<FirstWords>()

const SETTLED = FirstWords.Settled()
const held = new Map<ThreadId, FirstWords>()
// Threads this page has made, so sending again after a failed send does not make one twice.
const made = new Set<ThreadId>()
const landed = new Set<ThreadId>()
const watchers = new Set<() => void>()
const tell = () => {
  for (const watcher of watchers) watcher()
}

const stand = (id: ThreadId, standing: FirstWords) => {
  held.set(id, standing)
  tell()
}

/**
 * Makes the Thread if this page has not yet, then sends its first words, recording where they
 * stand at each step. The Thread must exist before the gateway will take a message for it.
 */
async function deliver(id: ThreadId, words: string, projectId: ProjectId | null) {
  stand(id, FirstWords.Sending({ words, projectId }))
  if (!made.has(id)) {
    const created = await change((client) =>
      client.CreateThread({ id, title: titleFromMessage(words), projectId }),
    )
    if (Result.isFailure(created)) {
      stand(id, FirstWords.Unsent({ words, projectId }))
      return
    }
    made.add(id)
    // The screen asked for this Thread before it existed and was told there was no such Thread.
    // Now there is, so the question is asked again.
    engine.reopen()
  }
  const sent = await createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` })
    .send({ message: { kind: 'user', body: words } })
    .then(
      () => true,
      () => false,
    )
  if (sent) {
    held.delete(id)
    landed.add(id)
    tell()
  } else {
    stand(id, FirstWords.Unsent({ words, projectId }))
  }
}

export const firstWords = {
  subscribe: (watcher: () => void) => {
    watchers.add(watcher)
    return () => {
      watchers.delete(watcher)
    }
  },
  /** Where a Thread's first words stand. The same object until they move, as a store must give. */
  of: (id: ThreadId): FirstWords => {
    const standing = held.get(id)
    return standing === undefined ? SETTLED : standing
  },
  /** Whether first words have landed since the page loaded, so the conversation is read again. */
  landed: (id: ThreadId) => landed.has(id),
  /** Sends unsent first words again. */
  again: (id: ThreadId) => {
    const standing = held.get(id)
    if (standing !== undefined && FirstWords.$is('Unsent')(standing)) {
      void deliver(id, standing.words, standing.projectId)
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
 */
export function startThread(message: string, projectId: ProjectId | null = null) {
  const id = ThreadId.make(crypto.randomUUID())
  stand(id, FirstWords.Sending({ words: message, projectId }))
  router.go(Route.Thread({ id }))
  void deliver(id, message, projectId)
}

/** Opens an empty Thread, for when the Person wants the page before the words. */
export async function openThread(projectId: ProjectId | null = null) {
  const id = ThreadId.make(crypto.randomUUID())
  const created = await change((client) =>
    client.CreateThread({ id, title: 'New thread', projectId }),
  )
  if (Result.isSuccess(created)) router.go(Route.Thread({ id }))
  return created
}

export { live }
