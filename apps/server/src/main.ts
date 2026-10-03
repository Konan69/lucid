import * as NodeHttp from 'node:http'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from '@effect/platform-node'
import { artifactStoreLayer } from './artifacts/store.ts'
import { gateLayer } from './approvals/gate.ts'
import { actionRunnerLayer } from './approvals/runner.ts'
import { approvalStoreLayer } from './approvals/store.ts'
import { approvalSweeperLayer } from './approvals/sweeper.ts'
import { auditLayer } from './audit/record.ts'
import { appearanceStoreLayer } from './appearance/store.ts'
import { companyStoreLayer } from './companies/store.ts'
import { codeAuthorityLayer } from './code/authority.ts'
import { codeCallsLayer } from './code/calls.ts'
import { codeProcessLayer } from './code/process.ts'
import { publicPageLayer } from './code/page.ts'
import { machineLayer } from './computers/provider.ts'
import { deviceLayer } from './computers/device.ts'
import { computerStoreLayer } from './computers/store.ts'
import { loadServerConfig, ServerConfig } from './config.ts'
import { executorLayer } from './connections/executor.ts'
import { connectionStoreLayer } from './connections/store.ts'
import { databaseLayer } from './database/client.ts'
import { routerLayer } from './http/router.ts'
import { staticRoutes } from './http/static.ts'
import { inputStoreLayer } from './inputs/store.ts'
import { libraryStoreLayer } from './library/store.ts'
import { changesLayer } from './live/changes.ts'
import { embeddingsLayer } from './memory/embeddings.ts'
import { memoryExtractionLayer } from './memory/extract.ts'
import { helixMemoryLayer } from './memory/helix.ts'
import { learningLayer, silentLearningLayer } from './memory/learn.ts'
import {
  memoryAccessLayer,
  memoryStoreLayer,
  unavailableMemoryAccessLayer,
} from './memory/store.ts'
import { notifierLayer } from './notifications/notifier.ts'
import { notificationStoreLayer } from './notifications/store.ts'
import { projectStoreLayer } from './projects/store.ts'
import { pushConfigLayer } from './push/config.ts'
import { pushAdapterLayer } from './push/adapter.ts'
import { pushLayer, pushReceiptsLayer } from './push/delivery.ts'
import { pushTargetsLayer } from './push/targets.ts'
import { routineSchedulerLayer, routineSchedulerServiceLayer } from './routines/scheduler.ts'
import { routineStoreLayer } from './routines/store.ts'
import { ruleJudgeLayer } from './rules/judge.ts'
import { ruleStoreLayer } from './rules/store.ts'
import { runtimeLayer } from './runtime/client.ts'
import { settingsStoreLayer } from './settings/store.ts'
import { skillStoreLayer } from './skills/store.ts'
import { conversationLayer } from './threads/delivery.ts'
import { presenceLayer } from './threads/presence.ts'
import { runStoreLayer } from './threads/runs.ts'
import { threadStoreLayer } from './threads/store.ts'

/**
 * Memory is an optional part of an installation. With `VIVID_HELIX_URL` set, Vivid remembers; with
 * it unset, every memory call answers that memory is unavailable and nothing is learned, which is
 * an expected state of a fresh install and not a fault.
 */
const memoryLayer = Layer.unwrap(
  Config.option(Config.String('VIVID_HELIX_URL')).pipe(
    Effect.map((address) =>
      Option.isNone(address)
        ? Layer.mergeAll(unavailableMemoryAccessLayer, silentLearningLayer)
        : learningLayer.pipe(
            Layer.provideMerge(memoryAccessLayer),
            Layer.provide(memoryStoreLayer),
            Layer.provide(Layer.mergeAll(helixMemoryLayer, embeddingsLayer)),
            Layer.provideMerge(memoryExtractionLayer),
          ),
    ),
  ),
)

/** The process entry point only selects implementations and owns their scoped lifetime. */
const serverProgram = Effect.fn('Server.launch')(function* () {
  const config = yield* loadServerConfig

  // Each tier may use everything below it. `provideMerge` keeps the lower tiers available to the
  // ones above, so the order here is the dependency order and nothing else.
  const platform = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    NodeHttpClient.layerUndici,
    NodeFileSystem.layer,
    NodePath.layer,
  )
  const data = databaseLayer.pipe(Layer.provideMerge(platform))
  const foundation = Layer.mergeAll(
    changesLayer,
    runtimeLayer,
    companyStoreLayer,
    settingsStoreLayer,
    projectStoreLayer,
    threadStoreLayer,
    runStoreLayer,
    notificationStoreLayer,
    ruleJudgeLayer,
    skillStoreLayer,
    libraryStoreLayer,
    executorLayer,
    machineLayer,
    codeProcessLayer,
    publicPageLayer,
    codeAuthorityLayer,
    deviceLayer,
  ).pipe(Layer.provideMerge(data))
  const pushConfiguration = Layer.mergeAll(presenceLayer, pushConfigLayer).pipe(
    Layer.provideMerge(foundation),
  )
  const pushFoundation = pushAdapterLayer.pipe(Layer.provideMerge(pushConfiguration))
  const targets = pushTargetsLayer.pipe(Layer.provideMerge(pushFoundation))
  const delivery = pushLayer.pipe(Layer.provideMerge(targets))
  const reach = Layer.mergeAll(
    notifierLayer,
    auditLayer,
    artifactStoreLayer,
    appearanceStoreLayer,
  ).pipe(Layer.provideMerge(delivery))
  const recorded = ruleStoreLayer.pipe(Layer.provideMerge(reach))
  const knowledge = memoryLayer.pipe(Layer.provideMerge(recorded))
  const conversation = conversationLayer.pipe(Layer.provideMerge(knowledge))
  const accounts = Layer.mergeAll(connectionStoreLayer, computerStoreLayer).pipe(
    Layer.provideMerge(conversation),
  )
  const trust = Layer.mergeAll(approvalStoreLayer, inputStoreLayer).pipe(
    Layer.provideMerge(actionRunnerLayer),
    Layer.provideMerge(accounts),
  )
  const decisions = gateLayer.pipe(Layer.provideMerge(trust))
  const work = Layer.mergeAll(routineStoreLayer, codeCallsLayer).pipe(Layer.provideMerge(decisions))
  const schedules = routineSchedulerServiceLayer.pipe(Layer.provideMerge(work))
  const background = Layer.mergeAll(routineSchedulerLayer, approvalSweeperLayer, pushReceiptsLayer)

  const server = NodeHttpServer.layer(() => NodeHttp.createServer(), {
    host: config.HOST,
    port: config.PORT,
  })
  const application = HttpRouter.serve(
    Layer.mergeAll(routerLayer, staticRoutes(config.VIVID_WEB_DIST), background),
  ).pipe(Layer.provide(schedules), Layer.provide(server))
  return yield* Layer.launch(application)
})()

NodeRuntime.runMain(serverProgram)
