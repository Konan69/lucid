import { describe, expect, it, layer } from '@effect/vitest'
import { Clock, Effect, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionId, ConnectionStep, ServiceAuthorization } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Executor, ExecutorOwnerId, ExecutorReferences, ExecutorStep } from './executor.ts'
import {
  GoogleState,
  googleAppName,
  googleFiles,
  googleReturnPath,
  googleServices,
} from './google.ts'
import { connectionReturnRoutes } from './return.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import {
  ConnectionProbe,
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedReturnAddress,
  hostedService,
  serviceId,
} from './testing.ts'

/** The real Executor Layer against the loopback Executor: what is asserted is what it sends. */
describe('Google Integrations', () => {
  it.effect('offers the six Google services first, and still does when the catalogue is down', () =>
    Effect.gen(function* () {
      const hosted = yield* hostedExecutorFixture()
      const names = googleServices.map((service) => service.name)
      expect(names).toEqual([
        'Gmail',
        'Google Calendar',
        'Google Drive',
        'Google Docs',
        'Google Sheets',
        'Google Tasks',
      ])
      const listed = yield* Effect.flatMap(Executor, (executor) => executor.catalog()).pipe(
        Effect.provide(hosted.configured),
      )
      const google = listed.slice(0, googleServices.length)
      expect(google.map((entry) => entry.name)).toEqual(names)
      expect(google.every((entry) => ServiceAuthorization.guards.SignIn(entry.authorization))).toBe(
        true,
      )
      // The icon is found by the product's own site, so every one of them names it.
      expect(google.map((entry) => entry.domain)).toEqual(
        googleServices.map((service) => service.domain),
      )
      expect(listed.some((entry) => entry.id === hostedService)).toBe(true)

      // A second Layer reads the catalogue afresh, and this time Executor's feed is refused.
      yield* Ref.update(hosted.replies, (replies) =>
        new Map(replies).set(`GET ${hostedPrefix}/catalog`, {
          status: 502,
          body: { _tag: 'CatalogUnavailable' },
        }),
      )
      const without = yield* Effect.flatMap(Executor, (executor) => executor.catalog()).pipe(
        Effect.provide(hosted.configured),
      )
      expect(without.map((entry) => entry.name)).toEqual(names)
    }),
  )

  it.effect(
    'deploys its own source once, finds it again, and signs in with the installation client',
    () =>
      Effect.gen(function* () {
        const hosted = yield* hostedExecutorFixture()
        const gmail = googleServices.find((service) => service.name === 'Gmail')
        if (gmail === undefined) return expect.fail('Gmail is one of the Google services')
        // What Executor reports for the deployed source: one account, signed in by OAuth.
        yield* Ref.set(hosted.accounts, {
          google: {
            provider: 'provider',
            definition: { auth: { googleOAuth2: { type: 'oauth2' } } },
          },
        })
        const input = {
          connectionId: ConnectionId.make('first'),
          service: gmail.service,
          owner: ExecutorOwnerId.make('owner'),
          subject: 'person',
          label: 'Work',
          returnAddress: hostedReturnAddress,
        }
        const { first, second } = yield* Effect.gen(function* () {
          const executor = yield* Executor
          return {
            first: yield* executor.begin(input),
            second: yield* executor.begin({ ...input, connectionId: ConnectionId.make('second') }),
          }
        }).pipe(Effect.provide(hosted.configured))
        if (!ExecutorStep.guards.OpenSignIn(first) || !ExecutorStep.guards.OpenSignIn(second))
          return expect.fail('A Google service begins with a sign-in')
        expect(ExecutorReferences.guards.GoogleSigningIn(first.references)).toBe(true)
        // The app is shared code: removing a Connection must never delete it.
        expect(first.references.appOwnership).toBe('Shared')
        expect(second.references.app).toBe(first.references.app)
        expect(second.references.profile).not.toBe(first.references.profile)

        const requests = yield* Ref.get(hosted.requests)
        const sent = (method: 'GET' | 'POST', path: string) =>
          requests.filter((request) => request.path === `${method} ${hostedPrefix}${path}`)
        // One deploy for two Connections, and never a catalogue install: Executor's catalogue
        // cannot install an OpenAPI entry.
        expect(sent('POST', '/apps/deploy').map((request) => request.body)).toEqual([
          { name: googleAppName(gmail), files: googleFiles(gmail) },
        ])
        expect(sent('POST', '/apps/install')).toHaveLength(0)
        // Executor is not asked whether a client is set up: Vivid sends its own on each start.
        expect(requests.filter((request) => request.path.includes('/providers/'))).toHaveLength(0)
        expect(
          sent('POST', '/connections/authorization/oauth/start').map((request) => request.body),
        ).toEqual(
          ['first', 'second'].map(() => ({
            method: 'googleOAuth2',
            label: 'Work',
            client: { clientId: 'isolated-test-client', clientSecret: 'isolated-test-secret' },
          })),
        )
      }),
  )
})

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
                  appOwnership: step.references.appOwnership,
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
