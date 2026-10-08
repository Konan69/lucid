import { describe, expect, layer } from '@effect/vitest'
import { Layer, Effect, Logger, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionStep, NotFound, SignInSurface } from '@vivid/contracts'
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
    for (const trip of [
      {
        name: 'Phone',
        from: SignInSurface.make('Phone'),
        resumeFrom: Option.none<SignInSurface>(),
        returnsTo: SignInSurface.make('Phone'),
      },
      {
        name: 'Web',
        from: SignInSurface.make('Web'),
        resumeFrom: Option.none<SignInSurface>(),
        returnsTo: SignInSurface.make('Web'),
      },
      {
        name: 'Phone resumed from Web',
        from: SignInSurface.make('Phone'),
        resumeFrom: Option.some(SignInSurface.make('Web')),
        returnsTo: SignInSurface.make('Web'),
      },
    ]) {
      test.effect(
        `${trip.name} returns through fixed state, refuses foreign and replayed state without writes`,
        () =>
          Effect.gen(function* () {
            const { ownerActor, memberActor } = yield* fixture()
            const config = yield* ServerConfig
            const remote = yield* hostedExecutorFixture()
            yield* Ref.set(
              remote.redirectUri,
              new URL('/api/connections/return', config.PUBLIC_URL).href,
            )
            yield* Ref.set(remote.accounts, {
              slot: { provider: 'provider', definition: { auth: { oauth: { type: 'oauth2' } } } },
            })
            yield* Effect.gen(function* () {
              // The return fixture records real OAuth submissions and callback target selection.
              const context = yield* Layer.build(remote.configured)
              return yield* Effect.gen(function* () {
                // Capture the hosted Executor so callback state uses this case's remote grant.
                const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
                return yield* Effect.gen(function* () {
                  const store = yield* ConnectionStore
                  let step = yield* store.begin(ownerActor, {
                    from: trip.from,
                    service: hostedService,
                    name: 'Sign in',
                    shared: false,
                  })
                  if (Option.isSome(trip.resumeFrom))
                    step = yield* store.resume(
                      ownerActor,
                      step.connection.id,
                      trip.resumeFrom.value,
                    )
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
                    yield* store
                      .callback(memberActor, step.connection.id, address)
                      .pipe(Effect.flip),
                  ).toBeInstanceOf(NotFound)
                  expect(yield* Ref.get(remote.requests)).toEqual(before)
                  expect(yield* store.get(ownerActor, step.connection.id)).toEqual(row)
                  const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
                  /**
                   * The browser as it comes back from the service: the exact provider URL and no
                   * Vivid session, which is what a browser opened by the phone app has.
                   */
                  const send = Effect.fn('Connections.ReturnTest.send')(function* () {
                    return yield* handle.pipe(
                      Effect.provideService(
                        HttpServerRequest.HttpServerRequest,
                        HttpServerRequest.fromWeb(new Request(callback)),
                      ),
                    )
                  })
                  const generic = new URL('/settings/connections', config.PUBLIC_URL).href
                  const response = yield* send()
                  expect(response.status).toBe(303)
                  expect(response.headers.location).toBe(
                    trip.returnsTo === 'Phone'
                      ? `vivid://integrations?connected=${step.connection.id}`
                      : new URL(
                          `/settings/connections?connected=${step.connection.id}`,
                          config.PUBLIC_URL,
                        ).href,
                  )
                  const completed = yield* store.get(ownerActor, step.connection.id)
                  const after = yield* Ref.get(remote.requests)
                  expect(
                    yield* store
                      .callback(ownerActor, step.connection.id, address)
                      .pipe(Effect.flip),
                  ).toBeInstanceOf(NotFound)
                  expect((yield* send()).headers.location).toBe(generic)
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
    }

    test.effect('redirects an unknown return while logging only a failure tag', () =>
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
                  `/api/connections/return?code=private-code&state=${'private-state'.repeat(3)}`,
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
          annotations: { 'error.type': 'NotFound', 'vivid.boundary': 'http' },
        })
        const written = JSON.stringify(lines)
        expect(written).not.toContain('private-code')
        expect(written).not.toContain('private-state')
      }),
    )
  })
})
