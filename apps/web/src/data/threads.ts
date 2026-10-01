import { createFlueClient } from '@flue/sdk'
import { ThreadId, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Data, Result } from 'effect'
import { change, live } from './live'
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
  Sending: { readonly words: string }
  Unsent: { readonly words: string }
}>
export const FirstWords = Data.taggedEnum<FirstWords>()

const SETTLED = FirstWords.Settled()
const held = new Map<ThreadId, FirstWords>()
const landed = new Set<ThreadId>()
const watchers = new Set<() => void>()
const tell = () => {
  for (const watcher of watchers) watcher()
}

/** Sends a Thread's first words and records where they stand. */
async function deliver(id: ThreadId, words: string) {
  held.set(id, FirstWords.Sending({ words }))
  tell()
  const sent = await createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` })
    .send({ message: { kind: 'user', body: words } })
    .then(
      () => true,
      () => false,
    )
  if (sent) {
    held.delete(id)
    landed.add(id)
  } else {
    held.set(id, FirstWords.Unsent({ words }))
  }
  tell()
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
      void deliver(id, standing.words)
    }
  },
}

/**
 * Starts a Thread with its first message: the path from the first screen, a suggestion, a
 * Project's "new thread" and a Library item's "ask about this".
 *
 * The Thread's id is made here so it can be on screen before the server has answered. The order
 * matters: the Thread must exist before the gateway will accept a message for it, so the message
 * is sent only after the create is confirmed, and the Person is already looking at the Thread by
 * then, reading their own words from `firstWords`.
 */
export async function startThread(message: string, projectId: ProjectId | null = null) {
  const id = ThreadId.make(crypto.randomUUID())
  const created = await change((client) =>
    client.CreateThread({ id, title: titleFromMessage(message), projectId }),
  )
  if (Result.isFailure(created)) return created
  router.go(Route.Thread({ id }))
  await deliver(id, message)
  return created
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
