import { Effect } from 'effect'
import type {
  AddIntegrationRequest,
  FindIntegrationsRequest,
  TestIntegrationRequest,
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionId,
  FindServicesRequest,
  FindToolsRequest,
  OfferConnectionRequest,
  RenameConnectionRequest,
  UseToolRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ConnectionStore } from './store.ts'
import { addIntegration, findIntegrations, testIntegration } from './integrations.ts'
import { findTools, offerConnection, resolveTool, useTool } from './tools.ts'
export { connectionRunner, runConnection } from './tools.ts'

/** Both inventory calls share the persisted Connection loader. */
const load = Effect.fn('Connections.load')(function* (actor: Actor) {
  return yield* (yield* ConnectionStore).list(actor)
})

/** Authentication belongs at transport ingress; account rules stay in the owned domain. */
export const connectionHandlers = {
  /** Discovery uses the same live Person/Company scope as every Connection read. */
  FindIntegrations: Effect.fn('Rpc.FindIntegrations')(function* (request: FindIntegrationsRequest) {
    return yield* findIntegrations(yield* requireActor(), request)
  }),
  /** Runtime authorization starts here; credential completion remains Person-only. */
  AddIntegration: Effect.fn('Rpc.AddIntegration')(function* (request: AddIntegrationRequest) {
    yield* requireVivid()
    return yield* addIntegration(yield* requireActor(), request)
  }),
  /** A read test is still an external account action and requires the ordinary Gate. */
  TestIntegration: Effect.fn('Rpc.TestIntegration')(function* (request: TestIntegrationRequest) {
    yield* requireVivid()
    return yield* testIntegration(yield* requireActor(), request)
  }),
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
  /** A name is the Person's to give; Vivid does not rename an account on its own. */
  RenameConnection: Effect.fn('Rpc.RenameConnection')(function* (request: RenameConnectionRequest) {
    yield* requirePerson()
    return { connection: yield* (yield* ConnectionStore).rename(yield* requireActor(), request) }
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
