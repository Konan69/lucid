import { createServer } from "node:http"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { apiLayer } from "./api.ts"
import { authEffect, localAuthRuntimeLayer } from "./auth.ts"
import { databaseLayer } from "./database.ts"
import { ServerConfig, loadServerConfig } from "./config.ts"

const authRoute = HttpRouter.add(
  "*",
  "/api/auth/*",
  Effect.gen(function*() {
    const auth = yield* authEffect
    return yield* auth.fetch.pipe(Effect.provide(localAuthRuntimeLayer))
  })
)

const healthRoute = HttpRouter.add(
  "GET",
  "/health",
  HttpServerResponse.jsonUnsafe({ ok: true, service: "vivid" })
)

const appLayer = Layer.mergeAll(apiLayer, authRoute, healthRoute).pipe(
  Layer.provide(HttpRouter.layer)
)

const serverProgram = Effect.gen(function*() {
  const config = yield* loadServerConfig
  const serverLayer = NodeHttpServer.layer(
    () => createServer(),
    {
      host: "127.0.0.1",
      port: config.PORT
    }
  )
  const configLayer = Layer.succeed(ServerConfig, config)
  const liveDatabaseLayer = databaseLayer.pipe(Layer.provide(configLayer))
  const servedAppLayer = HttpRouter.serve(appLayer)
  const nodeAppLayer = servedAppLayer.pipe(Layer.provide(serverLayer))
  const liveAppLayer = nodeAppLayer.pipe(
    Layer.provide(liveDatabaseLayer),
    Layer.provide(configLayer)
  )
  return yield* Layer.launch(liveAppLayer)
})

const program = Effect.catchTag(
  serverProgram,
  "ConfigurationError",
  (error) => Effect.sync(() => {
    console.error(`Configuration error: ${error.message}`)
    process.exitCode = 1
  })
)

NodeRuntime.runMain(program)
