import { describe, expect, layer } from '@effect/vitest'
import { Layer, Effect, Logger, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionStep, NotFound } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ServerConfig } from '../config.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionReturnRoutes } from './return.ts'
import {
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
} from './testing.ts'
import { Redacted } from 'effect'

/** Real sessions, persisted state, hosted adapter, and route dispatch prove correlation and replay
 * protection. Only Executor HTTP is simulated; no lookup or completion seam is mocked.
 */
describe.skipIf(!testDatabaseConfigured)('Connection provider return', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'starts and returns through fixed state, refuses foreign and replayed state without writes',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const database = yield* Database
          const config = yield* ServerConfig
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(
            remote.redirectUri,
            new URL('/api/connections/return', config.PUBLIC_URL).href,
          )
          yield* Ref.set(remote.accounts, {
            slot: { provider: 'provider', definition: { auth: { oauth: { type: 'oauth2' } } } },
          })
          const ownerToken = crypto.randomUUID()
          const memberToken = crypto.randomUUID()
          yield* database.run(
            database.insert(sessionTable).values([
              {
                id: crypto.randomUUID(),
                token: ownerToken,
                userId: ownerActor.person.id,
                expiresAt: new Date(Date.UTC(2099, 0, 1)),
              },
              {
                id: crypto.randomUUID(),
                token: memberToken,
                userId: memberActor.person.id,
                expiresAt: new Date(Date.UTC(2099, 0, 1)),
              },
            ]),
          )
          yield* Effect.gen(function* () {
            // This composed fixture owns per-case state and resources; build it in the test scope.
            const context = yield* Layer.build(remote.configured)
            return yield* Effect.gen(function* () {
              // Preserve local provision: rebuild against this case's overridden authorities.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* Effect.gen(function* () {
                const store = yield* ConnectionStore
                const step = yield* store.begin(ownerActor, {
                  service: hostedService,
                  name: 'Sign in',
                  shared: false,
                })
                if (!ConnectionStep.guards.OpenSignIn(step)) expect.fail('Expected hosted OAuth')
                const state = new URL(step.address).searchParams.get('state')
                const callback = new URL(
                  `/api/connections/return?state=${state}&code=private-code`,
                  config.PUBLIC_URL,
                )
                const address = Redacted.make(callback.href)
                const row = yield* store.get(ownerActor, step.connection.id)
                expect(JSON.stringify(row.references)).not.toContain(state)
                const before = yield* Ref.get(remote.requests)
                expect(
                  yield* store.callbackId(memberActor, address).pipe(Effect.flip),
                ).toBeInstanceOf(NotFound)
                expect(
                  yield* store.callback(memberActor, step.connection.id, address).pipe(Effect.flip),
                ).toBeInstanceOf(NotFound)
                expect(yield* Ref.get(remote.requests)).toEqual(before)
                expect(yield* store.get(ownerActor, step.connection.id)).toEqual(row)
                const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
                /** Route invocation passes the exact provider URL and authenticated session. */
                const send = Effect.fn('Connections.ReturnTest.send')(function* (token: string) {
                  return yield* handle.pipe(
                    Effect.provideService(
                      HttpServerRequest.HttpServerRequest,
                      HttpServerRequest.fromWeb(
                        new Request(callback, { headers: { authorization: `Bearer ${token}` } }),
                      ),
                    ),
                  )
                })
                const generic = new URL('/settings/connections', config.PUBLIC_URL).href
                expect((yield* send(memberToken)).headers.location).toBe(generic)
                expect((yield* send(ownerToken)).headers.location).toBe(
                  new URL(
                    `/settings/connections?connected=${step.connection.id}`,
                    config.PUBLIC_URL,
                  ).href,
                )
                const completed = yield* store.get(ownerActor, step.connection.id)
                const after = yield* Ref.get(remote.requests)
                expect(
                  yield* store.callbackId(ownerActor, address).pipe(Effect.flip),
                ).toBeInstanceOf(NotFound)
                expect(
                  yield* store.callback(ownerActor, step.connection.id, address).pipe(Effect.flip),
                ).toBeInstanceOf(NotFound)
                expect((yield* send(ownerToken)).headers.location).toBe(generic)
                expect(yield* store.get(ownerActor, step.connection.id)).toEqual(completed)
                expect(yield* Ref.get(remote.requests)).toEqual(after)
                expect(
                  after.filter(
                    (request) =>
                      request.path ===
                      `POST ${hostedPrefix}/connections/authorization/oauth/complete`,
                  ),
                ).toEqual([expect.objectContaining({ body: { callbackUrl: callback.href } })])
              }).pipe(Effect.provide(context))
            }).pipe(Effect.scoped, Effect.provide(context))
          }).pipe(Effect.scoped)
        }).pipe(Effect.scoped),
    )

    test.effect('redirects missing sessions while logging only a failure tag', () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig
        const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
        // Every field of every line: the message, its annotations and its cause. A private value
        // in any of them is a leak, so the whole structured line is what gets searched.
        const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
        const logger = Logger.make((options) => lines.push(Logger.formatStructured.log(options)))
        const response = yield* handle.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(
                new URL(
                  '/api/connections/return?code=private-code&state=private-state',
                  config.PUBLIC_URL,
                ),
              ),
            ),
          ),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        )
        expect(response.status).toBe(303)
        expect(response.headers.location).toBe(
          new URL('/settings/connections', config.PUBLIC_URL).href,
        )
        // One line for the one failure, naming it by tag.
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          message: 'Failure reached a boundary',
          annotations: { 'error.type': 'Unauthenticated', 'vivid.boundary': 'http' },
        })
        const written = JSON.stringify(lines)
        expect(written).not.toContain('private-code')
        expect(written).not.toContain('private-state')
      }),
    )
  })
})
