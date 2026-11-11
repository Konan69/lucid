import * as Effect from 'effect/Effect'
import {
  Forbidden,
  NotFound,
  PostRequest,
  type DismissFeedItemRequest,
  type MarkFeedCardRequest,
  type ResumeFeedItemRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { notifyPosted } from '../notifications/attention.ts'
import { requireThread } from '../threads/access.ts'
import { actingRun } from '../threads/runs.ts'
import { Database } from '../database/client.ts'
import { resumeFeedItem } from './resume.ts'
import { dismissFeedItem, FeedStore, markTold } from './store.ts'

/** What a notice quotes of a post: a said card's words; a drawn card is its drawing, with none. */
const bodyOf = (post: PostRequest) =>
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
  /** The Person put an item away, posted or not: it leaves the Feed and nothing is said to Vivid. */
  DismissFeedItem: Effect.fn('Rpc.DismissFeedItem')(function* (request: DismissFeedItemRequest) {
    const person = (yield* requireActor()).person.id
    const work = yield* requireThread(request.work, person)
    // Only the Person's own Threads are on their Feed (`read.ts` `mine`).
    if (work.personId !== person) return yield* new NotFound({ message: 'Thread not found' })
    return yield* dismissFeedItem(person, work.id)
  }),
  /** Pressing a Feed item is a Person's act: it opens the chat about its work (`resume.ts`). */
  ResumeFeedItem: Effect.fn('Rpc.ResumeFeedItem')(function* (request: ResumeFeedItemRequest) {
    yield* requirePerson()
    return yield* resumeFeedItem(yield* requireActor(), request)
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
    // Any Thread the Person owns may post, a Conversation as well as Background work: the Feed
    // already lists both (bbd12e6c7), and a card from a chat is how something found there waits
    // for the Person to approve or put away later (11 November 2026: "why is posting to feeds
    // not allowed in threads").
    const thread = yield* requireThread(auth.threadId, auth.person.id)
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
