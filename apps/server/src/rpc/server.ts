import * as Layer from 'effect/Layer'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import * as RpcServer from 'effect/rpc/RpcServer'
import { VividRpc } from '@vivid/contracts/rpc'
import { actionHandlers } from '../actions/handlers.ts'
import { actionLookupLayer } from '../actions/journal.ts'
import { appearanceHandlers } from '../appearance/handlers.ts'
import { artifactHandlers } from '../artifacts/handlers.ts'
import { approvalHandlers } from '../approvals/handlers.ts'
import { auditHandlers } from '../audit/handlers.ts'
import { buildHandlers } from '../builds/handlers.ts'
import { rpcAuthMiddlewareLayer } from '../auth/middleware.ts'
import { channelHandlers } from '../channels/handlers.ts'
import { companyHandlers } from '../companies/handlers.ts'
import { codeHandlers } from '../code/handlers.ts'
import { computerHandlers } from '../computers/handlers.ts'
import { connectionHandlers } from '../connections/handlers.ts'
import { draftHandlers } from '../drafts/handlers.ts'
import { draftStoreLayer } from '../drafts/store.ts'
import { feedHandlers } from '../feed/handlers.ts'
import { dreamHandlers } from '../dreams/handlers.ts'
import { feedStoreLayer } from '../feed/store.ts'
import { inputHandlers } from '../inputs/handlers.ts'
import { libraryHandlers } from '../library/handlers.ts'
import { memoryHandlers } from '../runtime/handlers.ts'
import { notificationHandlers } from '../notifications/handlers.ts'
import { projectHandlers } from '../projects/handlers.ts'
import { owedHandlers } from '../owed/handlers.ts'
import { todoHandlers } from '../todos/handlers.ts'
import { pushHandlers } from '../push/handlers.ts'
import { ruleHandlers } from '../rules/handlers.ts'
import { searchHandlers } from '../search/handlers.ts'
import { settingsHandlers } from '../settings/handlers.ts'
import { skillHandlers } from '../skills/handlers.ts'
import { childHandlers } from '../runs/handlers.ts'
import { threadHandlers } from '../threads/handlers.ts'
import { watchHandlers } from '../watches/handlers.ts'
import { requestProtocolLayer } from './requests.ts'
import { liveProtocolLayer } from './link.ts'

/**
 * Every product call, implemented once. `VividRpc.toLayer` is total over the contract: a call
 * declared in `packages/contracts/src/rpc.ts` with no handler here does not compile.
 */
export const rpcHandlersLayer = VividRpc.toLayer({
  ...artifactHandlers,
  ...channelHandlers,
  ...companyHandlers,
  ...codeHandlers,
  ...settingsHandlers,
  ...buildHandlers,
  ...appearanceHandlers,
  ...threadHandlers,
  ...childHandlers,
  ...approvalHandlers,
  ...actionHandlers,
  ...inputHandlers,
  ...ruleHandlers,
  ...auditHandlers,
  ...notificationHandlers,
  ...pushHandlers,
  ...projectHandlers,
  ...owedHandlers,
  ...todoHandlers,
  ...libraryHandlers,
  ...connectionHandlers,
  ...draftHandlers,
  ...memoryHandlers,
  ...skillHandlers,
  ...computerHandlers,
  ...searchHandlers,
  ...watchHandlers,
  ...feedHandlers,
  ...dreamHandlers,
}).pipe(Layer.provide(Layer.mergeAll(draftStoreLayer, feedStoreLayer, actionLookupLayer)))

/**
 * The live endpoint: one WebSocket per client, carrying every `Watch…` subscription and every
 * write. The browser sends its session cookie on the upgrade and a paired device its bearer token,
 * so each call on the socket is authenticated like any other. Its transport hears every client
 * message on the way in (`rpc/link.ts`).
 */
const liveLayer = RpcServer.layer(VividRpc).pipe(
  Layer.provide(liveProtocolLayer('/api/live')),
  Layer.provide(RpcSerialization.layerJson),
)

/**
 * The same calls over plain HTTP, for callers that want one answer and no socket: the runtime's
 * tools, scripts, and a client whose socket is down.
 */
const requestLayer = RpcServer.layer(VividRpc).pipe(
  Layer.provide(requestProtocolLayer),
  Layer.provide(RpcSerialization.layerNdjson),
)

export const rpcServerLayer = Layer.mergeAll(liveLayer, requestLayer).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(rpcAuthMiddlewareLayer),
)
