import { createFlueClient } from '@flue/sdk'
import { ThreadId, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Result } from 'effect'
import { change, live } from './live'
import { Route, router } from './route'

/**
 * Starts a Thread with its first message: the path from the first screen, a suggestion, a
 * Project's "new thread" and a Library item's "ask about this".
 *
 * The Thread's id is made here so it can be on screen before the server has answered. The order
 * matters: the Thread must exist before the gateway will accept a message for it, so the message
 * is sent only after the create is confirmed, and the Person is already looking at the Thread by
 * then.
 */
export async function startThread(message: string, projectId: ProjectId | null = null) {
  const id = ThreadId.make(crypto.randomUUID())
  const created = await change((client) =>
    client.CreateThread({ id, title: titleFromMessage(message), projectId }),
  )
  if (Result.isFailure(created)) return created
  router.go(Route.Thread({ id }))
  await createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` })
    .send({ message: { kind: 'user', body: message } })
    // The Thread screen is open on this conversation and draws a failed send itself.
    .catch(() => undefined)
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
