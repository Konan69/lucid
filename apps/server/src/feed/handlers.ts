import * as Effect from 'effect/Effect'
import { Forbidden, type MarkFeedCardRequest, type PostRequest } from '@vivid/contracts'
import { requireActor, requireVivid } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { actingRun } from '../threads/runs.ts'
import { FeedStore } from './store.ts'

export const feedHandlers = {
  /** List and Watch share one projection: the Person's own Feed, in any workspace. */
  ListFeed: Effect.fn('Rpc.ListFeed')(function* () {
    return yield* (yield* FeedStore).list((yield* requireActor()).person.id)
  }),
  WatchFeed: () =>
    live('WatchFeed', ['feed'], (actor) =>
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
    yield* actingRun(auth.threadId, auth.person.id).pipe(
      Effect.catchTag('NoActingRun', () =>
        Effect.fail(new Forbidden({ message: 'Posting to the Feed needs an acting Run.' })),
      ),
    )
    return yield* (yield* FeedStore).post({
      person: auth.person.id,
      thread: auth.threadId,
      request,
    })
  }),
}
