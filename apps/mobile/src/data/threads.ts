import { createFlueClient, type FlueClient } from '@flue/sdk'
import { regenerateThreadTitle } from '@vivid/client-runtime'
import { ThreadId, type CarryOnRequest, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Data, Effect, Redacted, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import { draft } from './drafts'
import type { Delivery } from './delivery'
import { firstKey, type Way } from './first'
import { refusalOf, type LiveData } from './live'
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
 * Tells Vivid to go on in a Thread once a card's wait is over ("GitHub is connected"). It is sent
 * as a `carry-on` signal (`CarryOnRequest`), which no surface draws, so it never reads as words
 * the Person said. It is tried twice, as a message is; when both fail the card is still the thing
 * the Thread waits on and offers its own Carry on. The web's is `carryOn` in `data/threads.ts`.
 */
export const carryOn = (data: LiveData, thread: ThreadId, body: string) => {
  const message = { kind: 'signal', type: 'carry-on', body } as const satisfies Omit<
    CarryOnRequest,
    'idempotencyKey'
  >
  const idempotencyKey = randomUUID()
  const client = conversation(data.session, thread)
  const once = () => client.send({ message, idempotencyKey })
  void once()
    .catch(once)
    .catch(() => undefined)
}

/**
 * Delivers one message into a Thread, described and not yet started. The gateway turns it into an
 * attributed message when the Thread is shared, so the same call serves a private Thread and a
 * shared one. It answers as soon as the server has admitted the message, not when Vivid has
 * replied.
 *
 * `key` names the delivery: sending again with the same key after a lost answer converges on the
 * first delivery instead of saying the same thing twice.
 */
export const say = (
  data: LiveData,
  delivery: {
    readonly id: ThreadId
    readonly body: string
    readonly key: string
    readonly pictures: Delivery['pictures']
  },
) =>
  data.running(
    Effect.tryPromise({
      try: (signal) =>
        conversation(data.session, delivery.id).send({
          message: { kind: 'user', body: delivery.body, attachments: [...delivery.pictures] },
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
 * - `NotSaid`: the Thread exists and is empty, because its first message did not arrive.
 */
export type Start = Data.TaggedEnum<{
  Started: { readonly id: ThreadId }
  NotCreated: { readonly message: string }
  NotSaid: { readonly id: ThreadId; readonly message: string }
}>
export const Start = Data.taggedEnum<Start>()

/** Makes an empty Thread under an id chosen here, named after the message it is started with. */
const createThread = (
  data: LiveData,
  thread: { readonly id: ThreadId; readonly message: string; readonly projectId: ProjectId | null },
) =>
  data.changing((client) =>
    client.CreateThread({
      id: thread.id,
      title: thread.message.trim().length === 0 ? UNTITLED : titleFromMessage(thread.message),
      projectId: thread.projectId,
    }),
  )

/**
 * Starts a Thread with its first message and answers when both are done: a Library item's "ask
 * about this", which stays on its own sheet until the Thread can be opened.
 *
 * The Thread must exist before the gateway will accept a message for it, so it is created first
 * and the message sent once that is confirmed. The first screen does the same two steps, but
 * shows the Thread while they run (`firstWay`).
 */
export const startThread = Effect.fn('Threads.start')(function* (
  data: LiveData,
  start: { readonly message: string; readonly projectId: ProjectId | null },
) {
  const id = ThreadId.make(randomUUID())
  const created = yield* createThread(data, { id, ...start })
  if (Result.isFailure(created)) return Start.NotCreated({ message: created.failure.message })
  // The Thread's id is also the delivery's name: a first message is said at most once.
  const said = yield* say(data, { id, body: start.message, key: firstKey(id), pictures: [] })
  return Result.isFailure(said)
    ? Start.NotSaid({ id, message: said.failure.message })
    : Start.Started({ id })
})

/**
 * How the first screen's first words reach the server (`deliver`, `data/first.ts`): the Thread is
 * made, then spoken in, each answering with why it did not go through.
 *
 * Words that did not arrive are put back in the composer they were typed in, unless the Person
 * has written something else there since. A Thread that was never made is not in the menu, so
 * its screen is not somewhere they can come back to; the composer is. Once the words are with
 * Vivid they are taken out of it again, when they are still what it holds.
 */
export const firstWay = (data: LiveData): Way => ({
  make: (id, start) =>
    createThread(data, { id, message: start.message.words, projectId: start.projectId }).pipe(
      Effect.map(refusalOf),
    ),
  say: (id, start) =>
    say(data, {
      id,
      body: start.message.words,
      key: firstKey(id),
      pictures: start.message.pictures,
    }).pipe(Effect.map(refusalOf)),
  returned: (start) => {
    if (draft.in(start.place).length === 0) draft.keep(start.place, start.words)
  },
  taken: (start) => {
    if (draft.in(start.place).trim() === start.words) draft.keep(start.place, '')
  },
})

/**
 * Changes a Thread's title or whether it is archived, shown before the server has confirmed it.
 * Described and not yet started, as every Thread change here is: a press starts it (`start`).
 */
export const patchThread = (
  data: LiveData,
  id: ThreadId,
  patch: {
    readonly title?: string
    readonly archived?: boolean
    readonly projectId?: ProjectId | null
  },
) =>
  data.changing(
    (client) => client.PatchThread({ id, patch }),
    () =>
      data.live.threads.expect((current) => ({
        threads: current.threads.map((thread) =>
          thread.id === id ? Object.assign({}, thread, patch) : thread,
        ),
      })),
  )

/**
 * Asks Vivid for a better title. Nothing is shown ahead of the answer, because the new title is
 * not known until Vivid has thought of it; the server publishes the Thread when it has, and the
 * list shows it then.
 */
export const retitleThread = (data: LiveData, id: ThreadId) =>
  data.running(regenerateThreadTitle(id))

/** Deletes a Thread for everyone who can see it. It leaves the list at once. */
export const deleteThread = (data: LiveData, id: ThreadId) =>
  data.changing(
    (client) => client.DeleteThread({ id }),
    () =>
      data.live.threads.expect((current) => ({
        threads: current.threads.filter((thread) => thread.id !== id),
      })),
  )
