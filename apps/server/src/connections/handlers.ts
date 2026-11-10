import { Effect } from 'effect'
import type {
  AddIntegrationRequest,
  MakeIntegrationRequest,
  ReadMadeIntegrationRequest,
  ReviseMadeIntegrationRequest,
  FindIntegrationsRequest,
  TestIntegrationRequest,
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionId,
  SignInSurface,
  FindServicesRequest,
  FindToolsRequest,
  OfferConnectionRequest,
  RenameConnectionRequest,
  SetConnectionPermissionRequest,
  UseDisplayToolRequest,
  UseToolRequest,
} from '@vivid/contracts'
import {
  requireActor,
  requirePerson,
  requireVivid,
  type Actor,
  requireRun,
} from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ConnectionStore } from './store.ts'
import {
  addIntegration,
  findIntegrations,
  authorIntegration,
  testIntegration,
} from './integrations.ts'
import { requireDiscordAccess, withoutDiscord } from './discord.ts'
import { findTools, offerConnection, resolveTool, useDisplayTool, useVividTool } from './tools.ts'
export { connectionRunner } from './tools.ts'

/** Both inventory calls share the persisted Connection loader. */
const load = Effect.fn('Connections.load')(function* (actor: Actor) {
  return yield* (yield* ConnectionStore).list(actor)
})

/** Authentication belongs at transport ingress; account rules stay in the owned domain. */
export const connectionHandlers = {
  /** Runtime source tools use the same acting Person authority as source creation. */
  ReadMadeIntegration: Effect.fn('Rpc.ReadMadeIntegration')(function* (
    request: ReadMadeIntegrationRequest,
  ) {
    yield* requireVivid()
    return yield* (yield* ConnectionStore).readMade(yield* requireActor(), request.account)
  }),
  ReviseMadeIntegration: Effect.fn('Rpc.ReviseMadeIntegration')(function* (
    request: ReviseMadeIntegrationRequest,
  ) {
    yield* requireVivid()
    return yield* (yield* ConnectionStore).reviseMade(yield* requireActor(), request)
  }),
  /** Discovery uses the same live Person/Company scope as every Connection read. */
  FindIntegrations: Effect.fn('Rpc.FindIntegrations')(function* (request: FindIntegrationsRequest) {
    return yield* findIntegrations(yield* requireActor(), request)
  }),
  /** Runtime authorization starts here; credential completion remains Person-only. */
  AddIntegration: Effect.fn('Rpc.AddIntegration')(function* (request: AddIntegrationRequest) {
    yield* requireVivid()
    return yield* addIntegration(yield* requireActor(), request)
  }),
  /** Source deployment has the same attributed Run authority as importing an address. */
  MakeIntegration: Effect.fn('Rpc.MakeIntegration')(function* (request: MakeIntegrationRequest) {
    yield* requireVivid()
    return yield* authorIntegration(yield* requireActor(), request)
  }),
  /** A read test is still an external account action and requires the ordinary Gate. */
  TestIntegration: Effect.fn('Rpc.TestIntegration')(function* (request: TestIntegrationRequest) {
    yield* requireVivid()
    return yield* testIntegration(yield* requireActor(), request)
  }),
  ListConnections: Effect.fn('Rpc.ListConnections')(function* () {
    return yield* load(yield* requireActor())
  }),
  WatchConnections: () => live('WatchConnections', [], load),
  /** The public catalog has no workspace scope; searching still requires a signed-in Person. */
  FindServices: Effect.fn('Rpc.FindServices')(function* (request: FindServicesRequest) {
    const { person } = yield* requirePerson()
    const store = yield* ConnectionStore
    return withoutDiscord(store.discordPeople, person, yield* store.find(request.query))
  }),
  /** Connecting an account always requires a signed-in Person. */
  BeginConnection: Effect.fn('Rpc.BeginConnection')(function* (request: BeginConnectionRequest) {
    const { person } = yield* requirePerson()
    const store = yield* ConnectionStore
    yield* requireDiscordAccess(store.discordPeople, person, request.service)
    return yield* store.begin(yield* requireActor(), request)
  }),
  /** Reopening authorization uses the same management authority as removal. */
  ResumeConnection: Effect.fn('Rpc.ResumeConnection')(function* ({
    id,
    from,
  }: {
    readonly id: ConnectionId
    readonly from: SignInSurface
  }) {
    yield* requirePerson()
    return yield* (yield* ConnectionStore).resume(yield* requireActor(), id, from)
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
  /** Permission choices are Person-only and retain Connection management ownership checks. */
  SetConnectionPermission: Effect.fn('Rpc.SetConnectionPermission')(function* (
    request: SetConnectionPermissionRequest,
  ) {
    yield* requirePerson()
    return {
      connection: yield* (yield* ConnectionStore).permission(yield* requireActor(), request),
    }
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
    yield* requireRun()
    return yield* useVividTool(yield* requireActor(), request)
  }),
  /** A display's Query or Mutation, for the Person looking at it; never Vivid's own call. */
  UseDisplayTool: Effect.fn('Rpc.UseDisplayTool')(function* (request: UseDisplayToolRequest) {
    yield* requirePerson()
    return yield* useDisplayTool(yield* requireActor(), request)
  }),
  /** Connection requests are contributions made by Vivid in a Run. */
  OfferConnection: Effect.fn('Rpc.OfferConnection')(function* (request: OfferConnectionRequest) {
    yield* requireVivid()
    const actor = yield* requireActor()
    yield* requireDiscordAccess(
      (yield* ConnectionStore).discordPeople,
      actor.person,
      request.service,
    )
    return yield* offerConnection(actor, request)
  }),
}
