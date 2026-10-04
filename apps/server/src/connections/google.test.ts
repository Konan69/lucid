import { describe, expect, layer } from '@effect/vitest'
import { Clock, Effect, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionStep } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Executor, ExecutorReferences, ExecutorStep } from './executor.ts'
import { GoogleState, googleReturnPath } from './google.ts'
import { connectionReturnRoutes } from './return.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'

/** Real sessions, persisted references and route dispatch prove the fixed callback selects only
 * its exact initiating Person and pending state. The deliberate Executor layer supplies protocol
 * state at its public boundary; the store and PostgreSQL lookup are the production implementations.
 */
describe.skipIf(!testDatabaseConfigured)('Google fixed callback', () => {
  layer(connectionTestLayer)((it) => {
    it.effect(
      'isolates simultaneous returns, rejects foreign/replayed state, and completes the exact Connection',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const database = yield* Database
          const config = yield* ServerConfig
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const executor = yield* Executor
          const google = Executor.of({
            ...executor,
            begin: Effect.fn('GoogleTest.begin')(function* (input) {
              const step = yield* executor.begin(input)
              if (!ExecutorStep.guards.OpenSignIn(step)) expect.fail('Sign-in fixture required')
              return ExecutorStep.cases.OpenSignIn.make({
                references: ExecutorReferences.cases.GoogleSigningIn.make({
                  service: step.references.service,
                  app: step.references.app,
                  profile: step.references.profile,
                  owner: step.references.owner,
                  authorization: step.references.authorization,
                  googleState: GoogleState.make(crypto.randomUUID()),
                }),
                address: step.address,
              })
            }),
          })
          const run = Effect.fn('GoogleTest.verifyReturns')(function* () {
            const store = yield* ConnectionStore
            const first = yield* store.begin(ownerActor, {
              service: serviceId,
              label: 'First',
              shared: false,
            })
            const second = yield* store.begin(ownerActor, {
              service: serviceId,
              label: 'Second',
              shared: false,
            })
            if (
              !ConnectionStep.guards.OpenSignIn(first) ||
              !ConnectionStep.guards.OpenSignIn(second)
            )
              expect.fail('Sign-in fixture required')
            const firstRow = yield* store.get(ownerActor, first.connection.id)
            const secondRow = yield* store.get(ownerActor, second.connection.id)
            if (
              !ExecutorReferences.guards.OAuthSigningIn(firstRow.references) ||
              !ExecutorReferences.guards.OAuthSigningIn(secondRow.references)
            )
              expect.fail('Pending references required')
            const ownerToken = crypto.randomUUID()
            const memberToken = crypto.randomUUID()
            const now = yield* Clock.currentTimeMillis.pipe(
              Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            )
            yield* database.run(
              database.insert(sessionTable).values([
                {
                  id: crypto.randomUUID(),
                  token: ownerToken,
                  userId: ownerActor.person.id,
                  expiresAt: new Date(now + 60_000),
                },
                {
                  id: crypto.randomUUID(),
                  token: memberToken,
                  userId: memberActor.person.id,
                  expiresAt: new Date(now + 60_000),
                },
              ]),
            )
            const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
            const send = Effect.fn('GoogleTest.return')(function* (state: string, token: string) {
              return yield* handle.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(
                    new Request(
                      new URL(`${googleReturnPath}?${state}&code=private-code`, config.PUBLIC_URL),
                      {
                        headers: { authorization: `Bearer ${token}` },
                      },
                    ),
                  ),
                ),
              )
            })
            const firstState = new URL(first.address).searchParams.get('state')
            const secondState = new URL(second.address).searchParams.get('state')
            const generic = new URL('/settings/connections', config.PUBLIC_URL).href
            expect((yield* send(`state=${firstState}`, memberToken)).headers.location).toBe(generic)
            expect(yield* Ref.get(probe.signIns)).toBe(0)
            expect(
              (yield* send(`state=${firstState}&state=${secondState}`, ownerToken)).headers
                .location,
            ).toBe(generic)
            expect((yield* send(`state=${crypto.randomUUID()}`, ownerToken)).headers.location).toBe(
              generic,
            )
            const completed = yield* send(`state=${secondState}`, ownerToken)
            expect(completed.headers.location).toBe(
              new URL(`/settings/connections?connected=${second.connection.id}`, config.PUBLIC_URL)
                .href,
            )
            expect((yield* store.get(ownerActor, first.connection.id)).status).toBe(
              'needs-authorization',
            )
            expect(yield* Ref.get(probe.signIns)).toBe(1)
            expect((yield* send(`state=${secondState}`, ownerToken)).headers.location).toBe(generic)
            expect(yield* Ref.get(probe.signIns)).toBe(1)
          })
          yield* run().pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, google),
          )
        }),
    )
  })
})
