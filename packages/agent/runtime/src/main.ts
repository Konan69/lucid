import * as NodeHttp from 'node:http'
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import { routes } from './app.ts'
import { productLayer } from './client.ts'
import { whileOwned } from './lifetime.ts'
import { modelsLayer } from './models.ts'
import { personsLayer, runtimeNotesLayer } from './persons.ts'
import { RuntimeSettings, settingsLayer } from './settings.ts'
import { builtinSkillsLayer } from './skills.ts'
import { storesLayer } from './storage/stores.ts'

/**
 * What the process holds before anything depends on the conversations: the settings and the
 * stores. Building `storesLayer` takes the runtime's authority over the stores, or fails when
 * another runtime holds it.
 */
const foundation = storesLayer.pipe(Layer.provideMerge(settingsLayer))

/**
 * What is built and served while the process owns the stores (`lifetime.ts`): the server's
 * client, the models, the built-in skills and every Person's conversations, then the HTTP
 * server. Building `personsLayer` resumes the replies a restart interrupted before the port is
 * bound; the address is logged once it is.
 */
const serving = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings
    const server = NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: settings.host,
      port: settings.port,
    })
    return HttpServer.withLogAddress(HttpRouter.serve(routes)).pipe(Layer.provide(server))
  }),
).pipe(
  Layer.provideMerge(
    personsLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(productLayer, modelsLayer, builtinSkillsLayer, runtimeNotesLayer),
      ),
    ),
  ),
)

/**
 * The conversation runtime as a plain Node process.
 *
 * Layers release in the reverse of the order they were built, so on SIGTERM (`runMain`
 * interrupts the program) the HTTP server stops taking requests first, then every Person's
 * Harness closes, joining its running tasks and its storage, then the stores, and the shared
 * HTTP client goes last because the tools those tasks were running used it. Work a close
 * interrupts stays pending in the store and resumes when the next process starts.
 *
 * Losing the control connection ends the program the same way, with a failure, whether it
 * happens while serving or while startup is still recovering stores (`lifetime.ts`); the process
 * exits non-zero so the platform starts a fresh one, which takes the authority over again.
 *
 * An empty environment value is kept as given: `VIVID_MODEL=""` is an undeclared model, not the
 * default (`providers/models.ts`).
 */
const entry = Layer.mergeAll(foundation, NodeHttpClient.layerUndici).pipe(
  // oxlint-disable-next-line vivid/no-config-provider-from-env-in-library -- This is the process entry point, the one place the environment becomes configuration.
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
)

NodeRuntime.runMain(
  // @effect-diagnostics-next-line strictEffectProvide:off -- The process entry point provides its composed Layer once.
  Effect.scoped(whileOwned(serving)).pipe(Effect.provide(entry)),
)
