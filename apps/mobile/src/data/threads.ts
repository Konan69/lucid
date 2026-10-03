import { createFlueClient, type FlueClient } from '@flue/sdk'
import { ThreadId, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Data, Effect, Option, Redacted, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import type { LiveData } from './live'
import { threadAddress } from './server'
import type { SignedIn } from './session'
import { streamingFetch } from './transport'

/**
 * Starting, speaking in and changing Threads.
 *
 * A Thread has two sides. Its record (title, audience, attention) is a product call on the live
 * socket. Its conversation is Flue's stream, reached only through the server's gateway at
 * `/api/vivid/<thread>`, which is what knows who is speaking; there is no other way to it.
 */

/** The title a Thread has until its first message names it; `openThread` on the web sets it. */
export const UNTITLED = 'New thread'

/** A Thread's conversation, opened as the signed-in Person. */
export const conversation = (session: SignedIn, id: ThreadId): FlueClient =>
  createFlueClient({
    url: threadAddress(session.server, id),
    token: Redacted.value(session.token),
    fetch: streamingFetch,
  })

/** A message was handed to the app and the server did not take it. */
export class Undelivered extends Schema.TaggedError<Undelivered>()(
  'Undelivered',
  { message: Schema.String },
  { title: 'Message undelivered' },
) {}

/** What a Person is told when a message left the phone and is not known to have arrived. */
export const UNDELIVERED =
  'That message did not reach Vivid. Check your connection and send it again.'

/**
 * Delivers one message into a Thread. The gateway turns it into an attributed message when the
 * Thread is shared, so the same call serves a private Thread and a shared one. It answers as
 * soon as the server has admitted the message, not when Vivid has replied.
 *
 * `key` names the delivery: sending again with the same key after a lost answer converges on the
 * first delivery instead of saying the same thing twice.
 */
export const say = (
  data: LiveData,
  delivery: { readonly id: ThreadId; readonly body: string; readonly key: string },
) =>
  data.run(
    Effect.tryPromise({
      try: (signal) =>
        conversation(data.session, delivery.id).send({
          message: { kind: 'user', body: delivery.body },
          idempotencyKey: delivery.key,
          signal,
        }),
      catch: () => new Undelivered({ message: UNDELIVERED }),
    }),
  )

/**
 * How far starting a Thread got.
 *
 * - `Started`: the Thread exists and its first message is with Vivid.
 * - `NotCreated`: the server refused the Thread; nothing exists.
 * - `NotSaid`: the Thread exists and is empty, because its first message did not arrive. Trying
 *   again with this `id` sends into it instead of making a second Thread.
 */
export type Start = Data.TaggedEnum<{
  Started: { readonly id: ThreadId }
  NotCreated: { readonly message: string }
  NotSaid: { readonly id: ThreadId; readonly message: string }
}>
export const Start = Data.taggedEnum<Start>()

/**
 * Starts a Thread with its first message: the path from the first screen, a suggestion and a
 * Library item's "ask about this".
 *
 * The Thread must exist before the gateway will accept a message for it, so it is created first
 * and the message sent once that is confirmed. The Person is taken to the Thread only when the
 * message is with Vivid, so words they typed are never dropped on the way to a screen that could
 * not say so.
 */
export async function startThread(
  data: LiveData,
  start: {
    readonly message: string
    readonly projectId: ProjectId | null
    /** A Thread an earlier attempt created and could not speak in. */
    readonly resume: Option.Option<ThreadId>
  },
): Promise<Start> {
  const id = Option.getOrElse(start.resume, () => ThreadId.make(randomUUID()))
  if (Option.isNone(start.resume)) {
    const created = await data.change((client) =>
      client.CreateThread({
        id,
        title: titleFromMessage(start.message),
        projectId: start.projectId,
      }),
    )
    if (Result.isFailure(created)) return Start.NotCreated({ message: created.failure.message })
  }
  // The Thread's id is also the delivery's name: a first message is said at most once.
  const said = await say(data, { id, body: start.message, key: `first:${id}` })
  return Result.isFailure(said)
    ? Start.NotSaid({ id, message: said.failure.message })
    : Start.Started({ id })
}

/** Changes a Thread's title or whether it is archived, shown before the server has confirmed it. */
export const patchThread = (
  data: LiveData,
  id: ThreadId,
  patch: {
    readonly title?: string
    readonly archived?: boolean
    readonly projectId?: ProjectId | null
  },
) =>
  data.change(
    (client) => client.PatchThread({ id, patch }),
    () =>
      data.live.threads.expect((current) => ({
        threads: current.threads.map((thread) =>
          thread.id === id ? Object.assign({}, thread, patch) : thread,
        ),
      })),
  )

/** Deletes a Thread for everyone who can see it. It leaves the list at once. */
export const deleteThread = (data: LiveData, id: ThreadId) =>
  data.change(
    (client) => client.DeleteThread({ id }),
    () =>
      data.live.threads.expect((current) => ({
        threads: current.threads.filter((thread) => thread.id !== id),
      })),
  )
