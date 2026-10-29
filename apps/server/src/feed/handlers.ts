import * as Effect from 'effect/Effect'
import { Forbidden, type MarkFeedCardRequest, type PostRequest } from '@vivid/contracts'
import { requireActor, requireVivid } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { notifyPosted } from '../notifications/attention.ts'
import { requireThread } from '../threads/access.ts'
import { actingRun } from '../threads/runs.ts'
import { FeedStore } from './store.ts'

export const feedHandlers = {
  /** List and Watch share one projection: the Person's own Feed, in any workspace. */
  ListFeed: Effect.fn('Rpc.ListFeed')(function* () {
    return yield* (yield* FeedStore).list((yield* requireActor()).person.id)
  }),
  WatchFeed: () =>
    // A Run starting or settling moves `activity`, which changes an item's stage.
    live('WatchFeed', ['feed', 'activity'], (actor) =>
      Effect.flatMap(FeedStore, (store) => store.list(actor.person.id)),
    ),
  /** The Person looked at a card or dealt with it. */
  MarkFeedCard: Effect.fn('Rpc.MarkFeedCard')(function* (request: typeof MarkFeedCardRequest.Type) {
    return yield* (yield* FeedStore).mark((yield* requireActor()).person.id, request)
  }),
  /**
   * Vivid putting a card on the Feed, from the Run it is in: the Person and the Thread come from
   * the Run's own authority, never from the model, so a card can only ever speak for the Thread
   * whose work it reports. A Run must be acting there, as for a notification (`attention.ts`).
   */
  Post: Effect.fn('Rpc.Post')(function* (request: typeof PostRequest.Type) {
    const auth = yield* requireVivid()
    const run = yield* actingRun(auth.threadId, auth.person.id).pipe(
      Effect.catchTag('NoActingRun', () =>
        Effect.fail(new Forbidden({ message: 'Posting to the Feed needs an acting Run.' })),
      ),
    )
    // Conversations show their reply in the Thread; only Background work composes a Feed post.
    const thread = yield* requireThread(auth.threadId, auth.person.id)
    if (thread.place !== 'Background')
      return yield* new Forbidden({
        message: 'The Person is in this conversation: answer here instead of posting to the Feed.',
      })
    const outcome = yield* (yield* FeedStore).post({
      person: auth.person.id,
      thread: auth.threadId,
      request,
    })
    // Once the card is committed, the Person is told, wherever they are (`notifyPosted`).
    yield* notifyPosted({ personId: auth.person.id, thread, run, post: request })
    return outcome
  }),
}
