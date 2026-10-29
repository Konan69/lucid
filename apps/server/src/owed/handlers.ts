import { Effect } from 'effect'
import {
  OwedListResponse,
  type TrackOwedRequest,
  type UpdateOwedRequest,
  type NudgedOwedRequest,
  type ResolveOwedRequest,
  type DropOwedRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { OwedStore } from './store.ts'

/** List and Watch load exactly the same owner-scoped projection. */
const owed = Effect.fn('Owed.list')(function* (actor: Actor) {
  return OwedListResponse.make({ owed: yield* (yield* OwedStore).list(actor) })
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
    return yield* (yield* OwedStore).resolve(yield* requireActor(), request)
  }),
  DropOwed: Effect.fn('Rpc.DropOwed')(function* (request: DropOwedRequest) {
    return yield* (yield* OwedStore).drop(yield* requireActor(), request)
  }),
}
