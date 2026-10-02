import { Effect } from 'effect'
import type {
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionId,
  FindServicesRequest,
  FindToolsRequest,
  OfferConnectionRequest,
  UseToolRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ConnectionStore } from './store.ts'
import { findTools, offerConnection, resolveTool, useTool } from './tools.ts'
export { connectionRunner, runConnection } from './tools.ts'

/** Both inventory calls share the persisted Connection loader. */
const load = Effect.fn('Connections.load')(function* (actor: Actor) {
  return yield* (yield* ConnectionStore).list(actor)
})

/** Authentication belongs at transport ingress; account rules stay in the owned domain. */
export const connectionHandlers = {
  ListConnections: Effect.fn('Rpc.ListConnections')(function* () {
    return yield* load(yield* requireActor())
  }),
  WatchConnections: () => live(load),
  /** The public catalog has no workspace scope; searching still requires a signed-in Person. */
  FindServices: Effect.fn('Rpc.FindServices')(function* (request: FindServicesRequest) {
    yield* requirePerson()
    return yield* (yield* ConnectionStore).find(request.query)
  }),
  /** Connecting an account always requires a signed-in Person. */
  BeginConnection: Effect.fn('Rpc.BeginConnection')(function* (request: BeginConnectionRequest) {
    yield* requirePerson()
    return yield* (yield* ConnectionStore).begin(yield* requireActor(), request)
  }),
  /** Reopening authorization uses the same management authority as removal. */
  ResumeConnection: Effect.fn('Rpc.ResumeConnection')(function* ({
    id,
  }: {
    readonly id: ConnectionId
  }) {
    yield* requirePerson()
    return yield* (yield* ConnectionStore).resume(yield* requireActor(), id)
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
  /** Exact resolution uses discovery's acting Person and account vocabulary. */
  ResolveTool: Effect.fn('Rpc.ResolveTool')(function* (request: {
    readonly account: string
    readonly tool: string
  }) {
    return yield* resolveTool(yield* requireActor(), request)
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
