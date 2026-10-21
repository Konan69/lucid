/* oxlint-disable vivid/no-cross-package-import -- Verification composition imports the real private server Layers without adding product exports. */
import { computerStoreLayer } from '../../../../apps/server/src/computers/store.ts'
import { absentMachineLayer } from '../../../../apps/server/src/computers/testing.ts'
import { deviceLayer } from '../../../../apps/server/src/computers/device.ts'
import { companyHandlers } from '../../../../apps/server/src/companies/handlers.ts'
import { companyStoreLayer } from '../../../../apps/server/src/companies/store.ts'
import { projectHandlers } from '../../../../apps/server/src/projects/handlers.ts'
import { projectStoreLayer } from '../../../../apps/server/src/projects/store.ts'
import { notificationHandlers } from '../../../../apps/server/src/notifications/handlers.ts'
import { notificationStoreLayer } from '../../../../apps/server/src/notifications/store.ts'
import { draftHandlers } from '../../../../apps/server/src/drafts/handlers.ts'
import { draftStoreLayer } from '../../../../apps/server/src/drafts/store.ts'
import { codeHandlers } from '../../../../apps/server/src/code/handlers.ts'
import { computerHandlers } from '../../../../apps/server/src/computers/handlers.ts'
import { publicPageLayer } from '../../../../apps/server/src/code/page.ts'
/** Port of verify-vivid-pi/scripts/server.ts:server. Current main uses Flue beside the server;
 * production handlers/stores remain unchanged and external model/notification services stay inert. */
import { auditLayer } from '../../../../apps/server/src/audit/record.ts'
import { approvalStoreLayer } from '../../../../apps/server/src/approvals/store.ts'
import { inputStoreLayer } from '../../../../apps/server/src/inputs/store.ts'
import { inputHandlers } from '../../../../apps/server/src/inputs/handlers.ts'
import { approvalHandlers } from '../../../../apps/server/src/approvals/handlers.ts'
import {
  ActionRunner,
  ActionOutcome,
  gateLayer,
} from '../../../../apps/server/src/approvals/gate.ts'
import { Reviewer } from '../../../../apps/server/src/approvals/review.ts'
import { Review } from '../../../../apps/server/src/approvals/policy.ts'
import { RuleJudge, RulesNotJudged } from '../../../../apps/server/src/rules/judge.ts'
import { ruleStoreLayer } from '../../../../apps/server/src/rules/store.ts'
import { authLayer } from '../../../../apps/server/src/auth/provider.ts'
import { artifactHandlers } from '../../../../apps/server/src/artifacts/handlers.ts'
import { artifactStoreLayer } from '../../../../apps/server/src/artifacts/store.ts'
import { skillHandlers } from '../../../../apps/server/src/skills/handlers.ts'
import { skillStoreLayer } from '../../../../apps/server/src/skills/store.ts'
import { appearanceHandlers } from '../../../../apps/server/src/appearance/handlers.ts'
import { appearanceStoreLayer } from '../../../../apps/server/src/appearance/store.ts'
import * as NodeHttp from 'node:http'
import * as NodeProcess from 'node:process'
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Config, ConfigProvider, Context, Effect, Layer, Predicate, Record, Schema } from 'effect'
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http'
import { RpcServer, RpcSerialization, RpcGroup } from 'effect/rpc'
import { VividRpc } from '@vivid/contracts/rpc'
import { ServiceUnavailable } from '@vivid/contracts'
import { requireActor } from '../../../../apps/server/src/auth/access.ts'
import { rpcAuthMiddlewareLayer } from '../../../../apps/server/src/auth/middleware.ts'
import { settingsHandlers } from '../../../../apps/server/src/settings/handlers.ts'
import { settingsStoreLayer } from '../../../../apps/server/src/settings/store.ts'
import { loadServerConfig, ServerConfig } from '../../../../apps/server/src/config.ts'
import { databaseLayer } from '../../../../apps/server/src/database/client.ts'
import { authRoute } from '../../../../apps/server/src/http/router.ts'
import { changesLayer } from '../../../../apps/server/src/live/changes.ts'
import { silentLearningLayer } from '../../../../apps/server/src/memory/testing.ts'
import { silentChannelRepliesLayer } from '../../../../apps/server/src/channels/replies.ts'
import { Notifier } from '../../../../apps/server/src/notifications/notifier.ts'
import { threadTitlesLayer } from '../../../../apps/server/src/threads/generation.ts'
import { MemoryModel, Completion } from '../../../../apps/server/src/memory/model.ts'
import { threadHandlers } from '../../../../apps/server/src/threads/handlers.ts'
import { conversationLayer } from '../../../../apps/server/src/threads/delivery.ts'
import { gatewayRoutes } from '../../../../apps/server/src/threads/gateway.ts'
import { presenceLayer } from '../../../../apps/server/src/threads/presence.ts'
import { runStoreLayer } from '../../../../apps/server/src/threads/runs.ts'
import { threadStoreLayer } from '../../../../apps/server/src/threads/store.ts'
import { runtimeLayer } from '../../../../apps/server/src/runtime/client.ts'

/** Launch without an IPC owner is a typed failure rather than an unrecorded server. */
class VerificationLaunchFailed extends Schema.TaggedError<VerificationLaunchFailed>()(
  'VerificationLaunchFailed',
  { role: Schema.String },
  { title: 'Verification launch failed' },
) {}

/** Only the owning test receives this receipt; native process logs never carry fixture credentials. */
const ready = Effect.fn('Verification.ready')(function* (role: 'server', address: string) {
  if (NodeProcess.send === undefined) return yield* VerificationLaunchFailed.make({ role })
  const send = NodeProcess.send.bind(NodeProcess)
  yield* Effect.sync(() => send({ _tag: 'Ready', address }))
  return undefined
})

/** Public production handlers preserve authentication, validation and SQL on every driven path. */
const handlers = {
  ...settingsHandlers,
  ...inputHandlers,
  ...approvalHandlers,
  ...threadHandlers,
  ...companyHandlers,
  ...projectHandlers,
  ...notificationHandlers,
  ...draftHandlers,
  ...artifactHandlers,
  ...skillHandlers,
  ...appearanceHandlers,
  ...computerHandlers,
  ReadPage: codeHandlers.ReadPage,
  /** Context discovery must receive a typed refusal at the excluded Integration boundary.
   * Omitting the RPC throws an unknown-tag defect before the runtime can degrade this read. */
  ListConnections: Effect.fn('Verification.ListConnections')(function* () {
    yield* requireActor()
    return yield* ServiceUnavailable.make({
      service: 'connections',
      message: 'External integrations are outside this isolated verification run.',
    })
  }),
}
/** The handler map is the only vocabulary: the guard narrows omitted RPCs without a cast or
 * a second hand-maintained list, and retains the original contract/auth middleware. */
const handled = (
  rpc: RpcGroup.Rpcs<typeof VividRpc>,
): rpc is Extract<RpcGroup.Rpcs<typeof VividRpc>, { readonly _tag: keyof typeof handlers }> =>
  Record.keys(handlers).some((tag) => Predicate.isTagged(rpc, tag))
const group = VividRpc.omit(
  ...[...VividRpc.requests.values()].flatMap((rpc) => (handled(rpc) ? [] : [rpc._tag])),
)

const rules = ruleStoreLayer.pipe(Layer.provideMerge(auditLayer))
const products = Layer.mergeAll(approvalStoreLayer, inputStoreLayer).pipe(
  Layer.provideMerge(
    Layer.succeed(ActionRunner, {
      run: () =>
        Effect.succeed(
          ActionOutcome.cases.Failed.make({
            reason: 'External execution is outside this isolated verification run.',
          }),
        ),
    }),
  ),
  Layer.provideMerge(rules),
)
const gate = gateLayer.pipe(
  Layer.provideMerge(products),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(Reviewer, {
        review: () =>
          Effect.succeed(Review.cases.Reviewed.make({ asked: 0, beyond: 1, contained: 0 })),
      }),
      Layer.succeed(RuleJudge, { judge: () => Effect.fail(new RulesNotJudged()) }),
    ),
  ),
)

/** Actual authenticated RPC owns product decisions; unrelated preparation ports are finite test data. */
const rpc = Layer.mergeAll(
  RpcServer.layerHttp({ group, path: '/api/rpc', protocol: 'http' }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
  ),
  RpcServer.layerHttp({ group, path: '/api/live', protocol: 'websocket' }).pipe(
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(
  Layer.provide(group.toLayer(handlers)),
  Layer.provide(rpcAuthMiddlewareLayer),
  Layer.provide(settingsStoreLayer),
)

/** This chain exercises production authentication, gateway, allocation and settlement. Providers for
 * the small title model, learning and notifications are explicit test Layers: main.ts requires external
 * memory authority, so importing its whole graph would violate the no-provider-key rehearsal proof.
 * Binding first supplies Better Auth with the actual origin, never a guessed or fixed fixture port. */
const server = Effect.fn('Verification.server')(function* () {
  const http = NodeHttp.createServer()
  const listener = NodeHttpServer.layer(() => http, {
    host: '127.0.0.1',
    port: yield* Config.Port('PORT'),
    disablePreemptiveShutdown: true,
  })
  const context = yield* Layer.build(listener)
  const address = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)
  const origin = yield* Layer.build(
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({
        PUBLIC_URL: yield* Config.String('PUBLIC_URL'),
        PORT: new URL(address).port,
      }),
      { asPrimary: true },
    ),
  )
  const config = yield* loadServerConfig.pipe(Effect.provideContext(origin))
  const platform = Layer.mergeAll(Layer.succeed(ServerConfig, config), NodeHttpClient.layerUndici)
  const data = authLayer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(platform))
  const computer = computerStoreLayer.pipe(
    Layer.provide(absentMachineLayer),
    Layer.provideMerge(changesLayer),
    Layer.provideMerge(data),
  )
  const foundation = Layer.mergeAll(
    changesLayer,
    companyStoreLayer,
    projectStoreLayer,
    notificationStoreLayer,
    draftStoreLayer,
    skillStoreLayer,
    publicPageLayer,
    deviceLayer,
    runtimeLayer,
    threadStoreLayer,
    runStoreLayer,
  ).pipe(Layer.provideMerge(computer))
  const configured = appearanceStoreLayer.pipe(
    Layer.provideMerge(settingsStoreLayer),
    Layer.provideMerge(foundation),
  )
  const surrounding = Layer.mergeAll(
    presenceLayer,
    settingsStoreLayer,
    silentLearningLayer,
    silentChannelRepliesLayer,
    threadTitlesLayer.pipe(
      Layer.provide(
        Layer.succeed(MemoryModel, {
          complete: () =>
            Effect.succeed(
              Completion.cases.Finished.make({
                text: JSON.stringify({ title: 'Rehearsal conversation' }),
              }),
            ),
        }),
      ),
    ),
    Layer.succeed(Notifier, { notify: () => Effect.void }),
  ).pipe(Layer.provideMerge(configured))
  const conversation = conversationLayer.pipe(Layer.provideMerge(surrounding))
  const decisions = gate.pipe(Layer.provideMerge(conversation))
  const domain = yield* Layer.build(artifactStoreLayer.pipe(Layer.provideMerge(decisions)))
  const application = HttpRouter.serve(
    Layer.mergeAll(
      authRoute,
      gatewayRoutes,
      rpc,
      HttpRouter.add(
        'GET',
        '/health',
        HttpServerResponse.jsonUnsafe({ ok: true, service: 'vivid' }),
      ),
    ),
    {
      disableLogger: true,
      disableListenLog: true,
    },
  ).pipe(Layer.provide(Layer.succeedContext(domain)), Layer.provide(Layer.succeedContext(context)))
  yield* Layer.build(application)
  // Match the shipped host's Node shutdown ordering, including a still-open aborted SSE socket.
  yield* Effect.addFinalizer(() => Effect.sync(() => http.closeAllConnections()))
  yield* ready('server', address)
  return yield* Effect.never
})

/** The owning CLI supplies the disposable configuration before importing product modules. */
NodeRuntime.runMain(server().pipe(Effect.scoped))
