import { integrationAnswersLayer } from './connections/asks.ts'
import { activitiesLayer } from './activity/service.ts'
import { commandWorkerLayer } from './computers/commands.ts'
import * as NodeHttp from 'node:http'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import * as HttpRouter from 'effect/http/HttpRouter'
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from '@effect/platform-node'
import { channelProviderLayer } from './channels/combined.ts'
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
import { codeComputerLayer } from './code/computer.ts'
import { codeProcessLayer } from './code/process.ts'
import { codeSourceLayer } from './code/source.ts'
import { publicPageLayer } from './code/page.ts'
import { boatMachineLayer } from './computers/boat.ts'
import { deviceLayer } from './computers/device.ts'
import { computerStoreLayer } from './computers/store.ts'
import { egressLayer } from './computers/egress/relay.ts'
import { loadServerConfig, ServerConfig } from './config.ts'
import { executorLayer } from './connections/executor.ts'
import { executorMembersLayer } from './connections/members.ts'
import { toolEffectsLayer } from './connections/effects.ts'
import { connectionStoreLayer } from './connections/store.ts'
import { workLayer } from './database/work.ts'
import { authLayer } from './auth/provider.ts'
import { databaseLayer } from './database/client.ts'
import { routerLayer } from './http/router.ts'
import { staticRoutes } from './http/static.ts'
import { inputStoreLayer } from './inputs/store.ts'
import { extractPdf, extractionAdmission } from './library/extraction.ts'
import { ingestionBackoff } from './library/ingestion.ts'
import { libraryIngestionLayer } from './library/worker.ts'
import { libraryStoreLayer } from './library/store.ts'
import { changesLayer } from './live/changes.ts'
import { tallyLayer } from './live/tally.ts'
import { titleModelLayer } from './threads/model.ts'
import { threadTitlesLayer } from './threads/generation.ts'
import { notificationDeliveryLayer } from './notifications/delivery.ts'
import { notifierLayer } from './notifications/notifier.ts'
import { observabilityLayer } from './observability/export.ts'
import { issuesLayer } from './observability/issues.ts'
import { notificationStoreLayer } from './notifications/store.ts'
import { projectStoreLayer } from './projects/store.ts'
import { owedStoreLayer } from './owed/store.ts'
import { todoStoreLayer } from './todos/store.ts'
import { forgetStoreLayer } from './forget/store.ts'
import { pushConfigLayer } from './push/config.ts'
import { pushAdapterLayer } from './push/adapter.ts'
import { pushLayer, pushReceiptsLayer } from './push/delivery.ts'
import { pushTargetsLayer } from './push/targets.ts'
import { decisionModelLayer } from './decisions/model.ts'
import { ruleJudgeLayer } from './rules/judge.ts'
import { ruleStoreLayer } from './rules/store.ts'
import { requestLimit } from './rpc/requests.ts'
import { cellMemoryLayer, runtimeLayer } from './runtime/client.ts'
import { settingsStoreLayer } from './settings/store.ts'
import { skillStoreLayer } from './skills/store.ts'
import { childRunsLayer } from './runs/store.ts'
import { conversationLayer } from './threads/delivery.ts'
import { presenceLayer } from './threads/presence.ts'
import { runStoreLayer } from './threads/runs.ts'
import { threadStoreLayer } from './threads/store.ts'
import { updateRoutes } from './updates/routes.ts'
import { watchedAppsLayer } from './watches/apps.ts'
import { executorEventsLayer } from './watches/events.ts'
import { watchesLayer, watchRenewalLayer } from './watches/lifecycle.ts'
import { feedPacingLayer } from './feed/pace.ts'
import { watchStoreLayer } from './watches/store.ts'

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
  const durable = Layer.mergeAll(workLayer, decisionModelLayer, authLayer).pipe(
    Layer.provideMerge(data),
  )
  const foundation = Layer.mergeAll(
    activitiesLayer,
    changesLayer,
    tallyLayer,
    channelProviderLayer,
    runtimeLayer,
    cellMemoryLayer,
    companyStoreLayer,
    settingsStoreLayer,
    projectStoreLayer,
    owedStoreLayer,
    todoStoreLayer,
    forgetStoreLayer,
    threadStoreLayer,
    runStoreLayer,
    notificationStoreLayer,
    ruleJudgeLayer,
    skillStoreLayer,
    libraryStoreLayer,
    executorLayer,
    executorMembersLayer,
    executorEventsLayer,
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
  const channels = Layer.mergeAll(channelStoreLayer, channelLedgerLayer).pipe(
    Layer.provideMerge(recorded),
  )
  const replying = channelRepliesLayer.pipe(Layer.provideMerge(channels))
  const named = threadTitlesLayer.pipe(Layer.provide(titleModelLayer), Layer.provideMerge(replying))
  const conversation = conversationLayer.pipe(Layer.provideMerge(named))
  const helpers = childRunsLayer.pipe(Layer.provideMerge(conversation))
  const accounts = Layer.mergeAll(
    connectionStoreLayer,
    toolEffectsLayer,
    computerStoreLayer,
    egressLayer,
  ).pipe(Layer.provideMerge(helpers))
  const trust = Layer.mergeAll(approvalStoreLayer, inputStoreLayer).pipe(
    Layer.provideMerge(actionRunnerLayer),
    Layer.provideMerge(accounts),
  )
  const answering = integrationAnswersLayer.pipe(Layer.provideMerge(trust))
  const decisions = gateLayer.pipe(Layer.provideMerge(reviewerLayer), Layer.provideMerge(answering))
  // A program runs on the Person's Computer, so its supervisor sits above the Computer store.
  const work = Layer.mergeAll(
    watchStoreLayer,
    watchedAppsLayer,
    codeCallsLayer,
    codeSourceLayer,
    codeProcessLayer.pipe(Layer.provide(codeComputerLayer)),
  ).pipe(Layer.provideMerge(decisions))
  const channelHandling = Layer.mergeAll(channelReceiverLayer, watchesLayer).pipe(
    Layer.provideMerge(work),
  )
  const background = Layer.mergeAll(
    commandWorkerLayer,
    watchRenewalLayer,
    feedPacingLayer,
    channelWorkerLayer,
    approvalSweeperLayer,
    pushReceiptsLayer,
    notificationDeliveryLayer,
    libraryIngestionLayer(ingestionBackoff, extractPdf),
    PersistedQueue.layerCleanup(),
  )

  const server = NodeHttpServer.layer(() => NodeHttp.createServer(), {
    host: config.HOST,
    websocket: { maxPayload: Number(requestLimit) },
    port: config.PORT,
  })
  const application = HttpRouter.serve(
    Layer.mergeAll(
      routerLayer,
      updateRoutes(config.VIVID_MOBILE_UPDATES, config.PUBLIC_URL),
      staticRoutes(config.VIVID_WEB_DIST),
      background,
    ),
  ).pipe(Layer.provide(channelHandling), Layer.provide(server))
  return yield* Layer.launch(application)
}).pipe(Effect.withSpan('Server.launch'))

NodeRuntime.runMain(
  Layer.launch(
    Layer.effectDiscard(serverProgram.pipe(Effect.withErrorReporting)).pipe(
      Layer.provide(issuesLayer),
    ),
  ),
)
