import * as Layer from 'effect/Layer'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { VividRpc } from '@vivid/contracts/rpc'
import { rpcAuthMiddlewareLayer } from '../auth/middleware.ts'
import { connectionHandlers } from '../connections/handlers.ts'
import { libraryHandlers } from '../library/handlers.ts'
import { notificationHandlers } from '../notifications/handlers.ts'
import { routineHandlers } from '../routines/handlers.ts'
import { taskHandlers } from '../tasks/handlers.ts'
import { threadHandlers } from '../threads/handlers.ts'

export const rpcHandlersLayer = VividRpc.toLayer({
  ...threadHandlers,
  ...taskHandlers,
  ...notificationHandlers,
  ...routineHandlers,
  ...libraryHandlers,
  ...connectionHandlers,
})

/** Mounts the schema-derived RPC server at the sole product JSON endpoint. */
export const rpcServerLayer = RpcServer.layerHttp({
  group: VividRpc,
  path: '/api/rpc',
  protocol: 'http',
}).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(rpcAuthMiddlewareLayer),
  Layer.provide(RpcSerialization.layerNdjson),
)
