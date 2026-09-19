import { createServer } from "node:http"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { apiLayer } from "./api.ts"
import { authEffect } from "./auth.ts"
import { databaseLayer } from "./database.ts"
import { ConfigurationError, ServerConfig, loadServerConfig } from "./config.ts"

const authRoute = HttpRouter.add(
  "*",
  "/api/auth/*",
  Effect.gen(function*() {
    const auth = yield* authEffect
    return yield* auth.fetch
  })
)

const healthRoute = HttpRouter.add(
  "GET",
  "/health",
  HttpServerResponse.jsonUnsafe({ ok: true, service: "vivid" })
)

const makeAppLayer = (config: ServerConfig["Service"]) => Layer.mergeAll(apiLayer, authRoute, healthRoute).pipe(
  Layer.provide(databaseLayer),
  Layer.provide(Layer.succeed(ServerConfig, config)),
  Layer.provide(HttpRouter.layer)
)

const program = Effect.gen(function*() {
  const config = yield* loadServerConfig
  const serverLayer = NodeHttpServer.layer(
    () => createServer(),
    {
      host: "127.0.0.1",
      port: config.PORT
    }
  )
  return yield* Layer.launch(HttpRouter.serve(makeAppLayer(config)).pipe(Layer.provide(serverLayer)))
}).pipe(
  Effect.catchTag("ConfigurationError", (error: ConfigurationError) =>
    Effect.sync(() => {
      console.error(`Configuration error: ${error.message}`)
      process.exitCode = 1
    })
  )
)

NodeRuntime.runMain(program)
