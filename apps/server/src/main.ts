import * as NodeHttp from 'node:http'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from '@effect/platform-node'
import { companyStoreLayer } from './companies/store.ts'
import { connectionStoreLayer } from './connections/store.ts'
import { loadServerConfig, ServerConfig } from './config.ts'
import { databaseLayer } from './database/client.ts'
import { routerLayer } from './http/router.ts'
import { libraryStoreLayer } from './library/store.ts'
import { projectStoreLayer } from './projects/store.ts'
import { routineSchedulerLayer, routineSchedulerServiceLayer } from './routines/scheduler.ts'
import { routineStoreLayer } from './routines/store.ts'
import { runtimeLayer } from './runtime/client.ts'
import { settingsStoreLayer } from './settings/store.ts'
import { followUpSchedulerLayer, followUpsLayer } from './tasks/followups.ts'
import { taskStoreLayer } from './tasks/store.ts'
import { threadStoreLayer } from './threads/store.ts'

/** The process entry point only selects implementations and owns their scoped lifetime. */
const serverProgram = Effect.fn('Server.launch')(function* () {
  const config = yield* loadServerConfig
  const configLayer = Layer.succeed(ServerConfig, config)
  const liveDatabase = databaseLayer.pipe(Layer.provide(configLayer))
  const platform = Layer.mergeAll(
    configLayer,
    liveDatabase,
    NodeHttpClient.layerUndici,
    NodeFileSystem.layer,
    NodePath.layer,
  )

  const workStores = Layer.mergeAll(
    routineStoreLayer,
    taskStoreLayer,
    threadStoreLayer,
    runtimeLayer,
  )
  const workStoresReady = workStores.pipe(Layer.provide(platform))
  const schedulerServices = Layer.merge(followUpsLayer, routineSchedulerServiceLayer).pipe(
    Layer.provide(workStoresReady),
  )
  const application = Layer.merge(
    routerLayer,
    Layer.merge(followUpSchedulerLayer, routineSchedulerLayer),
  )
  const server = NodeHttpServer.layer(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: config.PORT,
  })
  const liveServer = HttpRouter.serve(application).pipe(
    Layer.provide(schedulerServices),
    Layer.provide(companyStoreLayer.pipe(Layer.provide(platform))),
    Layer.provide(connectionStoreLayer.pipe(Layer.provide(platform))),
    Layer.provide(libraryStoreLayer.pipe(Layer.provide(platform))),
    Layer.provide(projectStoreLayer.pipe(Layer.provide(platform))),
    Layer.provide(settingsStoreLayer.pipe(Layer.provide(platform))),
    Layer.provide(workStoresReady),
    Layer.provide(platform),
    Layer.provide(server),
  )
  return yield* Layer.launch(liveServer)
})()

NodeRuntime.runMain(serverProgram)
