import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionStep, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Logger, Redacted } from 'effect'
import { executorLayer } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { findTools } from './tools.ts'

const enabled =
  NodeProcess.env['VIVID_LIVE_GITHUB'] === '1' &&
  NodeProcess.env['VIVID_TEST_DATABASE_URL'] !== undefined
const configured = executorLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GOOGLE_CLIENT_ID: 'isolated-test-client',
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

/** Real PostgreSQL ownership and real fork Executor credentials exercise the production
 * discovery seam together. The deliberate fixture Layer disables semantic classification;
 * neither the store, Executor adapter nor discovery's permission filtering is mocked. */
describe.skipIf(!enabled)('GitHub personal ownership acceptance', () => {
  layer(configured.pipe(Layer.provideMerge(connectionTestLayer)), { excludeTestServices: true })(
    (it) => {
      it.effect(
        'withholds a Person’s GitHub tools from another Person in the same Company',
        () =>
          Effect.gen(function* () {
            const { ownerActor, memberActor } = yield* fixture()
            yield* Effect.gen(function* () {
              // The store captures the live GitHub authority while SQL ownership remains real.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* Effect.gen(function* () {
                const store = yield* ConnectionStore
                const step = yield* store.begin(ownerActor, {
                  service: ServiceId.make('curated/github-com-mcp'),
                  name: 'Personal GitHub',
                  shared: false,
                })
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    const removed = yield* store
                      .remove(ownerActor, step.connection.id)
                      .pipe(Effect.exit)
                    expect(removed._tag).toBe('Success')
                  }),
                )
                if (!ConnectionStep.guards.EnterKey(step))
                  return expect.fail('GitHub must offer a secure personal token field')
                const token = NodeProcess.env['VIVID_TEST_GITHUB_TOKEN']
                if (token === undefined) return expect.fail('Supply personal token test authority')
                yield* store.complete(ownerActor, {
                  id: step.connection.id,
                  fields: { token: Redacted.make(token) },
                })
                const own = yield* findTools(ownerActor, { query: 'GitHub', limit: 25 })
                const other = yield* findTools(memberActor, { query: 'GitHub', limit: 25 })
                expect(own.tools.length).toBeGreaterThan(0)
                expect(other.tools.length).toBe(0)
                expect((yield* store.records(memberActor)).length).toBe(0)
                const refusal = yield* store.get(memberActor, step.connection.id).pipe(Effect.flip)
                expect(refusal._tag).toBe('NotFound')
                // Provider references and state may persist; credential values must never do so.
                const records = yield* store.records(ownerActor)
                expect(JSON.stringify(records).includes(token)).toBe(false)
                console.log('ok', own.tools.length)
              }).pipe(Effect.scoped, Effect.provide(context))
            }).pipe(Effect.scoped, Effect.scoped)
          }).pipe(Effect.scoped, Effect.provideService(Logger.CurrentLoggers, new Set([]))),
        { timeout: 120_000 },
      )
    },
  )
})
