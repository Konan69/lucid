import * as Effect from 'effect/Effect'
import { Forbidden, PostRequest, type MarkFeedCardRequest } from '@vivid/contracts'
import { requireActor, requireVivid } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { notifyPosted } from '../notifications/attention.ts'
import { requireThread } from '../threads/access.ts'
import { actingRun } from '../threads/runs.ts'
import { Database } from '../database/client.ts'
import { FeedStore, markTold } from './store.ts'

/** What a notice quotes of a post: a said card's words; a drawn card is its drawing, with none. */
export const bodyOf = (post: PostRequest) =>
  PostRequest.match(post, { Drawn: () => '', Said: ({ words }) => words })

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
  Post: Effect.fn('Rpc.Post')(function* (request: PostRequest) {
    const auth = yield* requireVivid()
    // The acting Run is the one posting this content; the store finds what started the work.
    const postedBy = yield* actingRun(auth.threadId, auth.person.id).pipe(
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
    return yield* (yield* Database).transaction(() =>
      Effect.gen(function* () {
        const outcome = yield* (yield* FeedStore).post({
          person: auth.person.id,
          thread: auth.threadId,
          postedBy,
          request,
        })
        // An urgent card is told at once, with sound, its delivery owed in the same transaction as
        // the card; an ordinary one waits on the Feed silently for the pacing pass, which tells at
        // most one a day in a quiet waking moment (`pace.ts`).
        if (request.urgency === 'urgent') {
          yield* notifyPosted({
            personId: auth.person.id,
            thread,
            run: postedBy,
            post: { title: request.title, body: bodyOf(request), urgency: request.urgency },
          })
          yield* markTold(auth.person.id, auth.threadId)
        }
        return outcome
      }),
    )
  }),
}
