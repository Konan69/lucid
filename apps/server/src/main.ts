import * as NodeHttp from 'node:http'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PersistedQueue from 'effect/unstable/persistence/PersistedQueue'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from '@effect/platform-node'
import { photonLayer } from './channels/photon.ts'
import { channelStoreLayer } from './channels/store.ts'
import { channelLedgerLayer } from './channels/ledger.ts'
import { channelReceiverLayer } from './channels/inbound.ts'
import { channelRepliesLayer } from './channels/replies.ts'
import { channelWorkerLayer } from './channels/worker.ts'
import { artifactStoreLayer } from './artifacts/store.ts'
import { gateLayer } from './approvals/gate.ts'
import { reviewerLayer } from './approvals/review.ts'
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
import { boatMachineLayer } from './computers/boat.ts'
import { deviceLayer } from './computers/device.ts'
import { computerStoreLayer } from './computers/store.ts'
import { loadServerConfig, ServerConfig } from './config.ts'
import { executorLayer } from './connections/executor.ts'
import { toolEffectsLayer } from './connections/effects.ts'
import { connectionStoreLayer } from './connections/store.ts'
import { workLayer } from './database/work.ts'
import { databaseLayer } from './database/client.ts'
import { routerLayer } from './http/router.ts'
import { staticRoutes } from './http/static.ts'
import { inputStoreLayer } from './inputs/store.ts'
import { extractPdf, extractionAdmission } from './library/extraction.ts'
import { ingestionBackoff } from './library/ingestion.ts'
import { libraryIngestionLayer } from './library/worker.ts'
import { libraryStoreLayer } from './library/store.ts'
import { changesLayer } from './live/changes.ts'
import { embeddingsLayer } from './memory/embeddings.ts'
import { memoryModelLayer } from './memory/model.ts'
import { threadTitlesLayer } from './threads/generation.ts'
import { memoryExtractionLayer } from './memory/extract.ts'
import { helixMemoryLayer } from './memory/helix.ts'
import { learningLayer } from './memory/learn.ts'
import { memoryAccessLayer, memoryStoreLayer } from './memory/store.ts'
import { notifierLayer } from './notifications/notifier.ts'
import { observabilityLayer } from './observability/export.ts'
import { notificationStoreLayer } from './notifications/store.ts'
import { projectStoreLayer } from './projects/store.ts'
import { pushConfigLayer } from './push/config.ts'
import { pushAdapterLayer } from './push/adapter.ts'
import { pushLayer, pushReceiptsLayer } from './push/delivery.ts'
import { pushTargetsLayer } from './push/targets.ts'
import { routineSchedulerLayer, routineSchedulerServiceLayer } from './routines/scheduler.ts'
import { routineStoreLayer } from './routines/store.ts'
import { decisionModelLayer } from './decisions/model.ts'
import { ruleJudgeLayer } from './rules/judge.ts'
import { ruleStoreLayer } from './rules/store.ts'
import { runtimeLayer } from './runtime/client.ts'
import { settingsStoreLayer } from './settings/store.ts'
import { skillStoreLayer } from './skills/store.ts'
import { conversationLayer } from './threads/delivery.ts'
import { presenceLayer } from './threads/presence.ts'
import { runStoreLayer } from './threads/runs.ts'
import { threadStoreLayer } from './threads/store.ts'
import { updateRoutes } from './updates/routes.ts'

/**
 * Memory is part of every Vivid. `VIVID_HELIX_URL` and the model gateway key are required while
 * these Layers are built, so a server without them does not start; there is no server that runs
 * "without memory". Helix not answering, or an index still building, is a typed failure on the
 * memory call that met it, and the next call tries again (`memory/helix.ts`).
 */
const memoryLayer = learningLayer.pipe(
  Layer.provideMerge(memoryAccessLayer),
  Layer.provide(memoryStoreLayer),
  Layer.provide(Layer.mergeAll(helixMemoryLayer, embeddingsLayer)),
  Layer.provideMerge(memoryExtractionLayer),
)

/** The process entry point only selects implementations and owns their scoped lifetime. */
const serverProgram = Effect.gen(function* () {
  // Refuse before configuration and Layer acquisition: server misconfiguration must never spend
  // a document's durable ingestion budget or accept uploads whose extraction cannot be bounded.
  yield* extractionAdmission
  const config = yield* loadServerConfig

  // Each tier may use everything below it. `provideMerge` keeps the lower tiers available to the
  // ones above, so the order here is the dependency order and nothing else.
  // Telemetry sits in the lowest tier so the tracer and the export logger are in the context
  // every tier above is built and run with. Its own HTTP client is provided to it directly.
  const platform = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    NodeHttpClient.layerUndici,
    NodeFileSystem.layer,
    NodePath.layer,
    observabilityLayer(config.OBSERVABILITY).pipe(Layer.provide(NodeHttpClient.layerUndici)),
  )
  const data = databaseLayer.pipe(Layer.provideMerge(platform))
  const durable = Layer.mergeAll(workLayer, decisionModelLayer).pipe(Layer.provideMerge(data))
  const foundation = Layer.mergeAll(
    changesLayer,
    photonLayer,
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
    boatMachineLayer,
    publicPageLayer,
    codeAuthorityLayer,
    deviceLayer,
  ).pipe(Layer.provideMerge(durable))
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
  const knowledge = Layer.mergeAll(memoryLayer, memoryModelLayer).pipe(Layer.provideMerge(recorded))
  const channels = Layer.mergeAll(channelStoreLayer, channelLedgerLayer).pipe(
    Layer.provideMerge(knowledge),
  )
  const replying = channelRepliesLayer.pipe(Layer.provideMerge(channels))
  const named = threadTitlesLayer.pipe(Layer.provideMerge(replying))
  const conversation = conversationLayer.pipe(Layer.provideMerge(named))
  const accounts = Layer.mergeAll(connectionStoreLayer, toolEffectsLayer, computerStoreLayer).pipe(
    Layer.provideMerge(conversation),
  )
  const trust = Layer.mergeAll(approvalStoreLayer, inputStoreLayer).pipe(
    Layer.provideMerge(actionRunnerLayer),
    Layer.provideMerge(accounts),
  )
  const decisions = gateLayer.pipe(Layer.provideMerge(reviewerLayer), Layer.provideMerge(trust))
  // A program is interpreted in this process; its calls go through the decisions below.
  const work = Layer.mergeAll(routineStoreLayer, codeCallsLayer, codeProcessLayer).pipe(
    Layer.provideMerge(decisions),
  )
  const channelHandling = channelReceiverLayer.pipe(Layer.provideMerge(work))
  const schedules = routineSchedulerServiceLayer.pipe(Layer.provideMerge(channelHandling))
  const background = Layer.mergeAll(
    routineSchedulerLayer,
    channelWorkerLayer,
    approvalSweeperLayer,
    pushReceiptsLayer,
    libraryIngestionLayer(ingestionBackoff, extractPdf),
    PersistedQueue.layerCleanup(),
  )

  const server = NodeHttpServer.layer(() => NodeHttp.createServer(), {
    host: config.HOST,
    port: config.PORT,
  })
  const application = HttpRouter.serve(
    Layer.mergeAll(
      routerLayer,
      updateRoutes(config.VIVID_MOBILE_UPDATES, config.PUBLIC_URL),
      staticRoutes(config.VIVID_WEB_DIST),
      background,
    ),
  ).pipe(Layer.provide(schedules), Layer.provide(server))
  return yield* Layer.launch(application)
}).pipe(Effect.withSpan('Server.launch'))

NodeRuntime.runMain(serverProgram)
