import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import * as RpcTest from 'effect/unstable/rpc/RpcTest'
import { VividRpc } from '@vivid/contracts/rpc'
import { VividRpcClient } from '@vivid/client-runtime'
import { NotFound, TaskId, Unauthenticated } from '@vivid/contracts'
import { companyStoreLayer } from '../companies/store.ts'
import { connectionStoreLayer } from '../connections/store.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { libraryStoreLayer } from '../library/store.ts'
import { projectStoreLayer } from '../projects/store.ts'
import { routineSchedulerServiceLayer } from '../routines/scheduler.ts'
import { routineStoreLayer } from '../routines/store.ts'
import { Runtime } from '../runtime/client.ts'
import { settingsStoreLayer } from '../settings/store.ts'
import { followUpsLayer } from '../tasks/followups.ts'
import { taskStoreLayer } from '../tasks/store.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { rpcAuthMiddlewareLayer } from '../auth/middleware.ts'
import { rpcHandlersLayer } from './server.ts'

const runtimeToken = 'test-runtime-token'
const configLayer = testConfigLayer
const runtimeLayer = Layer.succeed(Runtime, {
  start: () => Effect.succeed({ accepted: true, submissionId: 'test-submission' }),
})
const workStores = Layer.mergeAll(
  routineStoreLayer,
  taskStoreLayer,
  threadStoreLayer,
  runtimeLayer,
).pipe(Layer.provide(testDatabaseLayer))
const schedulerServices = Layer.merge(followUpsLayer, routineSchedulerServiceLayer).pipe(
  Layer.provide(workStores),
)
/**
 * Every dependency the RPC handlers and the auth middleware need, against the disposable database.
 * `RpcTest.makeClient` then runs the real handlers and the real middleware in process: what this
 * suite proves is the contract, authentication and persistence. The HTTP mount is one line in
 * `server.ts` and is exercised by booting the stack.
 */
const handlerDependencies = Layer.mergeAll(
  schedulerServices,
  workStores,
  companyStoreLayer.pipe(Layer.provide(testDatabaseLayer)),
  connectionStoreLayer.pipe(Layer.provide(configLayer)),
  libraryStoreLayer.pipe(Layer.provide(testDatabaseLayer)),
  projectStoreLayer.pipe(Layer.provide(testDatabaseLayer)),
  settingsStoreLayer.pipe(Layer.provide(testDatabaseLayer)),
  testDatabaseLayer,
  configLayer,
)
const integrationLayer = Layer.effect(VividRpcClient, RpcTest.makeClient(VividRpc)).pipe(
  Layer.provide(rpcHandlersLayer),
  Layer.provide(rpcAuthMiddlewareLayer),
  Layer.provide(handlerDependencies),
)
const asRuntime = RpcClient.withHeaders({ authorization: `Bearer ${runtimeToken}` })

describe.skipIf(!testDatabaseConfigured)('VividRpc HTTP integration', () => {
  layer(integrationLayer)((it) => {
    it.effect('serves each moved product area through one authenticated RPC client', () =>
      Effect.gen(function* () {
        const client = yield* VividRpcClient
        const id = TaskId.make(NodeCrypto.randomUUID())
        yield* Effect.addFinalizer(() =>
          client.DeleteTask({ id }).pipe(asRuntime).pipe(Effect.ignore),
        )

        expect((yield* client.ListThreads().pipe(asRuntime)).conversations).toBeInstanceOf(Array)
        expect(
          (yield* client.CreateTask({ id, title: 'RPC integration task' }).pipe(asRuntime)).task.id,
        ).toBe(id)
        expect((yield* client.ListNotifications().pipe(asRuntime)).notifications).toBeInstanceOf(
          Array,
        )
        expect((yield* client.ListRoutines().pipe(asRuntime)).routines).toBeInstanceOf(Array)
        expect((yield* client.ListLibrary({}).pipe(asRuntime)).documents).toBeInstanceOf(Array)
        expect((yield* client.ListConnections().pipe(asRuntime)).connectors).toHaveLength(3)
      }),
    )

    it.effect('returns typed unauthenticated and not-found failures', () =>
      Effect.gen(function* () {
        const client = yield* VividRpcClient
        const unauthenticated = yield* client
          .ListTasks({ status: 'open' })
          .pipe(RpcClient.withHeaders({ authorization: '' }), Effect.flip)
        expect(unauthenticated).toBeInstanceOf(Unauthenticated)

        const missing = yield* client
          .PatchTask({
            id: TaskId.make(NodeCrypto.randomUUID()),
            patch: { title: 'Missing' },
          })
          .pipe(asRuntime, Effect.flip)
        expect(missing).toBeInstanceOf(NotFound)
      }),
    )
  })
})
