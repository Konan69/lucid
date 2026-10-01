import { Effect } from 'effect'
import type {
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionId,
  FindToolsRequest,
  OfferConnectionRequest,
  UseToolRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ConnectionStore } from './store.ts'
import { findTools, offerConnection, useTool } from './tools.ts'
export { connectionRunner, runConnection } from './tools.ts'

/** Both inventory calls share one loader, including degraded catalog behavior. */
const load = Effect.fn('Connections.load')(function* (actor: Actor) {
  return yield* (yield* ConnectionStore).list(actor)
})

/** Authentication belongs at transport ingress; account rules stay in the owned domain. */
export const connectionHandlers = {
  ListConnections: Effect.fn('Rpc.ListConnections')(function* () {
    return yield* load(yield* requireActor())
  }),
  WatchConnections: () => live(load),
  /** Connecting an account always requires a signed-in Person. */
  BeginConnection: Effect.fn('Rpc.BeginConnection')(function* (request: BeginConnectionRequest) {
    yield* requirePerson()
    return yield* (yield* ConnectionStore).begin(yield* requireActor(), request)
  }),
  /** Key entry stays on the Person-only boundary and never enters Thread context. */
  CompleteConnection: Effect.fn('Rpc.CompleteConnection')(function* (
    request: CompleteConnectionRequest,
  ) {
    yield* requirePerson()
    return { connection: yield* (yield* ConnectionStore).complete(yield* requireActor(), request) }
  }),
  /** Vivid cannot revoke an account on its own. */
  RemoveConnection: Effect.fn('Rpc.RemoveConnection')(function* ({
    id,
  }: {
    readonly id: ConnectionId
  }) {
    yield* requirePerson()
    yield* (yield* ConnectionStore).remove(yield* requireActor(), id)
  }),
  FindTools: Effect.fn('Rpc.FindTools')(function* (request: FindToolsRequest) {
    return yield* findTools(yield* requireActor(), request)
  }),
  /** Only a Run proposes tool actions to the gate. */
  UseTool: Effect.fn('Rpc.UseTool')(function* (request: UseToolRequest) {
    yield* requireVivid()
    return yield* useTool(yield* requireActor(), request)
  }),
  /** Connection requests are contributions made by Vivid in a Run. */
  OfferConnection: Effect.fn('Rpc.OfferConnection')(function* (request: OfferConnectionRequest) {
    yield* requireVivid()
    return yield* offerConnection(yield* requireActor(), request)
  }),
}
