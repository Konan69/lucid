import * as Layer from 'effect/Layer'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { VividRpc } from '@vivid/contracts/rpc'
import { artifactHandlers } from '../artifacts/handlers.ts'
import { approvalHandlers } from '../approvals/handlers.ts'
import { auditHandlers } from '../audit/handlers.ts'
import { rpcAuthMiddlewareLayer } from '../auth/middleware.ts'
import { companyHandlers } from '../companies/handlers.ts'
import { codeHandlers } from '../code/handlers.ts'
import { computerHandlers } from '../computers/handlers.ts'
import { connectionHandlers } from '../connections/handlers.ts'
import { inputHandlers } from '../inputs/handlers.ts'
import { libraryHandlers } from '../library/handlers.ts'
import { memoryHandlers } from '../memory/handlers.ts'
import { notificationHandlers } from '../notifications/handlers.ts'
import { projectHandlers } from '../projects/handlers.ts'
import { routineHandlers } from '../routines/handlers.ts'
import { ruleHandlers } from '../rules/handlers.ts'
import { searchHandlers } from '../search/handlers.ts'
import { settingsHandlers } from '../settings/handlers.ts'
import { skillHandlers } from '../skills/handlers.ts'
import { threadHandlers } from '../threads/handlers.ts'

/**
 * Every product call, implemented once. `VividRpc.toLayer` is total over the contract: a call
 * declared in `packages/contracts/src/rpc.ts` with no handler here does not compile.
 */
export const rpcHandlersLayer = VividRpc.toLayer({
  ...artifactHandlers,
  ...companyHandlers,
  ...codeHandlers,
  ...settingsHandlers,
  ...threadHandlers,
  ...approvalHandlers,
  ...inputHandlers,
  ...ruleHandlers,
  ...auditHandlers,
  ...notificationHandlers,
  ...routineHandlers,
  ...projectHandlers,
  ...libraryHandlers,
  ...connectionHandlers,
  ...memoryHandlers,
  ...skillHandlers,
  ...computerHandlers,
  ...searchHandlers,
})

/**
 * The live endpoint: one WebSocket per client, carrying every `Watch…` subscription and every
 * write. The browser sends its session cookie on the upgrade and a paired device its bearer token,
 * so each call on the socket is authenticated like any other.
 */
const liveLayer = RpcServer.layerHttp({
  group: VividRpc,
  path: '/api/live',
  protocol: 'websocket',
}).pipe(Layer.provide(RpcSerialization.layerJson))

/**
 * The same calls over plain HTTP, for callers that want one answer and no socket: the runtime's
 * tools, scripts, and a client whose socket is down.
 */
const requestLayer = RpcServer.layerHttp({
  group: VividRpc,
  path: '/api/rpc',
  protocol: 'http',
}).pipe(Layer.provide(RpcSerialization.layerNdjson))

export const rpcServerLayer = Layer.mergeAll(liveLayer, requestLayer).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(rpcAuthMiddlewareLayer),
)
