import { describe, expect, layer } from '@effect/vitest'
import { Effect, Logger, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionId, ServiceUnavailable } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ServerConfig } from '../config.ts'
import { Executor, ExecutorStatus } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionReturnRoutes } from './return.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'

/** Real sessions and route dispatch prove expired-session redirects without mocking auth. */
describe.skipIf(!testDatabaseConfigured)('Connection provider return', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('redirects absent and lapsed sessions and logs only the failure tag and id', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const database = yield* Database
        const token = crypto.randomUUID()
        yield* database.run(
          database.insert(sessionTable).values({
            id: crypto.randomUUID(),
            token,
            userId: ownerActor.person.id,
            expiresAt: new Date(0),
          }),
        )
        const config = yield* ServerConfig
        const id = ConnectionId.make(crypto.randomUUID())
        const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
        const messages: string[] = []
        const logger = Logger.make((options) => messages.push(JSON.stringify(options.message)))
        for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
          const request = new Request(
            new URL(`/api/connections/return/${id}?code=callback-secret`, config.PUBLIC_URL),
            { headers },
          )
          const response = yield* handle.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Effect.provide(Logger.layer([logger])),
          )
          expect(response.status).toBe(303)
          expect(response.headers.location).toBe(
            new URL(`/settings/connections?failed=${id}`, config.PUBLIC_URL).href,
          )
        }
        expect(messages).toEqual(
          Array(2).fill(JSON.stringify([{ tag: 'Unauthenticated', connectionId: id }])),
        )
        expect(messages.join()).not.toContain('callback-secret')
        expect(messages.join()).not.toContain(token)
      }),
    )
    it.effect(
      'redirects authenticated success and failure without logging the provider address or diagnostics',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const database = yield* Database
          const config = yield* ServerConfig
          const token = crypto.randomUUID()
          yield* database.run(
            database.insert(sessionTable).values({
              id: crypto.randomUUID(),
              token,
              userId: ownerActor.person.id,
              expiresAt: new Date(Date.UTC(2099, 0, 1)),
            }),
          )
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const step = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Return account',
            shared: false,
          })
          const messages: string[] = []
          const logger = Logger.make((options) => messages.push(JSON.stringify(options.message)))
          const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
          const send = Effect.fn('Connections.Test.return')(function* (id: ConnectionId) {
            return yield* handle.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    new URL(
                      `/api/connections/return/${id}?code=callback-secret`,
                      config.PUBLIC_URL,
                    ),
                    { headers: { authorization: `Bearer ${token}` } },
                  ),
                ),
              ),
              Effect.provide(Logger.layer([logger])),
            )
          })
          const success = yield* send(step.connection.id)
          expect(success.status).toBe(303)
          expect(success.headers.location).toBe(
            new URL(`/settings/connections?connected=${step.connection.id}`, config.PUBLIC_URL)
              .href,
          )
          expect(messages).toEqual([])
          const missing = ConnectionId.make(crypto.randomUUID())
          expect((yield* send(missing)).headers.location).toBe(
            new URL(`/settings/connections?failed=${missing}`, config.PUBLIC_URL).href,
          )
          expect(messages).toEqual([JSON.stringify([{ tag: 'NotFound', connectionId: missing }])])
          const executor = yield* Executor
          const failed = Executor.of({
            ...executor,
            completeSignIn: Effect.fn('Executor.Test.returnUnavailable')(() =>
              Effect.fail(
                new ServiceUnavailable({
                  service: 'connections',
                  message: 'Provider address code=callback-secret Bearer credential-secret',
                }),
              ),
            ),
          })
          const failure = yield* send(step.connection.id).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, failed),
          )
          expect(failure.status).toBe(303)
          expect(failure.headers.location).toBe(
            new URL(`/settings/connections?failed=${step.connection.id}`, config.PUBLIC_URL).href,
          )
          expect(messages.at(-1)).toBe(
            JSON.stringify([{ tag: 'ServiceUnavailable', connectionId: step.connection.id }]),
          )
          expect(messages.join()).not.toContain('callback-secret')
          expect(messages.join()).not.toContain('credential-secret')
          const setupFailed = Executor.of({
            ...executor,
            status: Effect.fn('Executor.Test.returnFailedState')(() =>
              Effect.succeed(ExecutorStatus.cases.Failed.make({ reason: 'Service setup failed' })),
            ),
          })
          const notReady = yield* send(step.connection.id).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, setupFailed),
          )
          expect(notReady.status).toBe(303)
          expect(notReady.headers.location).toBe(
            new URL(`/settings/connections?failed=${step.connection.id}`, config.PUBLIC_URL).href,
          )
          expect(messages.at(-1)).toBe(
            JSON.stringify([{ tag: 'Failed', connectionId: step.connection.id }]),
          )

          yield* Ref.set(probe.step, 'Done')
        }),
    )
  })
})
