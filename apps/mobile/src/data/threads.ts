import { regenerateThreadTitle, VividRpcClient } from '@vivid/client-runtime'
import { ThreadId, type ProjectId } from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Data, Effect, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import { draft } from './drafts'
import type { Delivery } from './delivery'
import { firstKey, type Way } from './first'
import { refusalOf, type LiveData } from './live'
import * as App from './app'
import { offerNotifications } from './notifying'

/**
 * Starting, speaking in and changing Threads.
 *
 * A Thread has two sides, both on the live socket. Its record (title, audience, attention) is
 * one live query, and its conversation another (`live.conversation`, `data/live.ts`). What is
 * said in it goes to the server as a delivery (`SendToThread`), and the server, which knows who
 * is speaking, hands it to the runtime that holds the Thread.
 */

/** The title a Thread has until its first message names it; `openThread` on the web sets it. */
export const UNTITLED = 'New thread'

/** A message was handed to the app and the server did not take it. */
export class Undelivered extends Schema.TaggedError<Undelivered>()(
  'Undelivered',
  { message: Schema.String },
  { title: 'Message undelivered' },
) {}

/** What a Person is told when a message left the phone and is not known to have arrived. */
export const UNDELIVERED =
  'That message did not reach Vivid. Check your connection and send it again.'

/** A card resumes Vivid as an internal signal, with one key shared by its retry. */
export const carryOn = (data: LiveData, thread: ThreadId, body: string) => {
  const key = randomUUID()
  void App.start(
    data.changing((client) =>
      client.CarryOnThread({ threadId: thread, body, key }).pipe(Effect.retry({ times: 1 })),
    ),
  )
}

/**
 * Delivers one message into a Thread, described and not yet started. The server turns it into an
 * attributed message when the Thread is shared, so the same call serves a private Thread and a
 * shared one. It answers as soon as the runtime has admitted the message, not when Vivid has
 * replied.
 *
 * `key` names the delivery: sending again with the same key after a lost answer converges on the
 * first delivery instead of saying the same thing twice. A Thread's composer sends through the
 * Thread's machine instead (`data/sending.ts`); this is for first words, which are said before
 * there is a Thread to keep a machine for.
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
  data
    .running(
      VividRpcClient.use((client) =>
        client.SendToThread({
          threadId: delivery.id,
          text: delivery.body,
          pictures: delivery.pictures,
          key: delivery.key,
        }),
      ),
    )
    .pipe(Effect.map(Result.mapError((): Undelivered => new Undelivered({ message: UNDELIVERED }))))

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
    // The Person's first words are the moment Vivid offers to notify them (`data/notifying.ts`).
    Effect.sync(() => offerNotifications(data)).pipe(
      Effect.andThen(
        say(data, {
          id,
          body: start.message.words,
          key: firstKey(id),
          pictures: start.message.pictures,
        }),
      ),
      Effect.map(refusalOf),
    ),
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
