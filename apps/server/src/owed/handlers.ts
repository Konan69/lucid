import { Effect, Option } from 'effect'
import {
  OwedListResponse,
  OwedResultUndelivered,
  type TrackOwedRequest,
  type UpdateOwedRequest,
  type NudgedOwedRequest,
  type ResolveOwedRequest,
  type DropOwedRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { OwedStore } from './store.ts'
import { cardPostedBy } from '../feed/store.ts'
import { requireThread } from '../threads/access.ts'
import { actingRun } from '../threads/runs.ts'

/** List and Watch load exactly the same owner-scoped projection. */
const owed = Effect.fn('Owed.list')(function* (actor: Actor) {
  return OwedListResponse.make({ owed: yield* (yield* OwedStore).list(actor) })
})

/**
 * Work nobody is watching closes what the Person waited on only after telling them: this Run has
 * posted to its Background Thread's Feed card. In a conversation the reply tells them, and a
 * Person's own press is theirs to make, so neither is held. B4826, from Muse's "a task you took on
 * stays open until its result reaches the user" (`muse/workspace/system/system_prompt.md:183`).
 */
const requireDelivered = Effect.fn('Owed.requireDelivered')(function* (
  actor: Actor,
  request: ResolveOwedRequest,
) {
  if (actor.by !== 'vivid' || Option.isNone(actor.threadId)) return
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  if (thread.place !== 'Background') return
  const run = yield* actingRun(thread.id, actor.person.id).pipe(Effect.option)
  const posted = yield* cardPostedBy(actor.person.id, thread.id)
  if (Option.isSome(run) && Option.contains(posted, run.value)) return
  return yield* new OwedResultUndelivered({
    id: request.id,
    message: 'Post the result to the Feed first; it stays open until the Person has been told.',
  })
})

/** RpcServer decodes requests and encodes replies using the shared contracts. */
export const owedHandlers = {
  ListOwed: Effect.fn('Rpc.ListOwed')(function* () {
    return yield* owed(yield* requireActor())
  }),
  WatchOwed: () => live('WatchOwed', [], owed),
  TrackOwed: Effect.fn('Rpc.TrackOwed')(function* (request: TrackOwedRequest) {
    return yield* (yield* OwedStore).track(yield* requireActor(), request)
  }),
  UpdateOwed: Effect.fn('Rpc.UpdateOwed')(function* (request: UpdateOwedRequest) {
    return yield* (yield* OwedStore).update(yield* requireActor(), request)
  }),
  NudgedOwed: Effect.fn('Rpc.NudgedOwed')(function* (request: NudgedOwedRequest) {
    return yield* (yield* OwedStore).nudged(yield* requireActor(), request)
  }),
  ResolveOwed: Effect.fn('Rpc.ResolveOwed')(function* (request: ResolveOwedRequest) {
    const actor = yield* requireActor()
    yield* requireDelivered(actor, request)
    return yield* (yield* OwedStore).resolve(actor, request)
  }),
  DropOwed: Effect.fn('Rpc.DropOwed')(function* (request: DropOwedRequest) {
    return yield* (yield* OwedStore).drop(yield* requireActor(), request)
  }),
}
