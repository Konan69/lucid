import { describe, expect, it, layer } from '@effect/vitest'
import { Layer, Effect, Ref, Schema } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import { ConnectionId, ConnectionStep, ServiceAuthorization } from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  ExecutorAppOwnership,
  Executor,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorStep,
  installationCaller,
} from './executor.ts'
import { GoogleState, googleReturnPath, googleServices } from './google.ts'
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
      const listed = yield* Effect.gen(function* () {
        // Read the initial catalogue through this case's controlled HTTP feed.
        const context = yield* Layer.build(hosted.configured)
        return yield* Effect.flatMap(Executor, (executor) => executor.catalog).pipe(
          Effect.provide(context),
        )
      }).pipe(Effect.scoped)
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
          body: Schema.TaggedStruct('CatalogUnavailable', {}).make({}),
        }),
      )
      const without = yield* Effect.gen(function* () {
        // Bypass catalogue memoization so the refused second feed is actually requested.
        const context = yield* Layer.build(Layer.fresh(hosted.configured))
        return yield* Effect.flatMap(Executor, (executor) => executor.catalog).pipe(
          Effect.provide(context),
        )
      }).pipe(Effect.scoped)
      expect(without.map((entry) => entry.name)).toEqual([...names, 'GitHub', 'Discord'])
    }),
  )

  it.effect('deploys separate Google apps and signs in with the installation client', () =>
    Effect.gen(function* () {
      const hosted = yield* hostedExecutorFixture()
      const gmail = googleServices.find((service) => service.name === 'Gmail')
      if (gmail === undefined) expect.fail('Gmail is one of the Google services')
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
        // The installation recorder proves separate Connections deploy separate Google apps.
        const context = yield* Layer.build(hosted.configured)
        return yield* Effect.gen(function* () {
          const executor = yield* Executor
          return {
            first: yield* executor.as(installationCaller).begin(input),
            second: yield* executor.as(installationCaller).begin({
              ...input,
              connectionId: ConnectionId.make('second'),
            }),
          }
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped)
      if (!ExecutorStep.guards.OpenSignIn(first) || !ExecutorStep.guards.OpenSignIn(second))
        expect.fail('A Google service begins with a sign-in')
      expect(ExecutorReferences.guards.GoogleSigningIn(first.references)).toBe(true)
      // Separate Connections cannot replace each other's app account link.
      expect(second.references.app).not.toBe(first.references.app)

      const requests = yield* Ref.get(hosted.requests)
      const sent = (method: 'GET' | 'POST', path: string) =>
        requests.filter((request) => request.path === `${method} ${hostedPrefix}${path}`)
      // Deploy Vivid's authored Google source for each Connection rather than a catalog entry.
      const deployed = sent('POST', '/apps/deploy')
      expect(deployed).toHaveLength(2)
      const [deployment] = deployed
      if (deployment === undefined) expect.fail('Expected Gmail deployment')
      expect(deployment.body).toMatchObject({
        name: expect.stringMatching(/^Vivid Gmail [0-9a-f]{16} /u),
      })
      const source = JSON.stringify(deployment.body)
      for (const required of [
        'https://accounts.google.com/o/oauth2/v2/auth',
        'https://oauth2.googleapis.com/token',
        'https://mail.google.com/',
        'https://www.googleapis.com/auth/gmail.settings.basic',
      ])
        expect(source).toContain(required)
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
  layer(connectionTestLayer)((test) => {
    test.effect(
      'isolates simultaneous returns, rejects foreign/replayed state, and completes the exact Connection',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const config = yield* ServerConfig
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const executor = yield* Executor
          const google = Executor.of({
            ...executor,
            as: (caller) => ({
              ...executor.as(caller),
              begin: Effect.fn('GoogleTest.begin')(function* (input) {
                const step = yield* executor.as(installationCaller).begin(input)
                if (!ExecutorStep.guards.OpenSignIn(step)) expect.fail('Sign-in fixture required')
                return ExecutorStep.cases.OpenSignIn.make({
                  references: ExecutorReferences.cases.GoogleSigningIn.make({
                    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
                    service: step.references.service,
                    app: step.references.app,
                    binding: step.references.binding,
                    owner: step.references.owner,

                    authorization: step.references.authorization,
                    googleState: GoogleState.make(crypto.randomUUID()),
                  }),
                  address: step.address,
                })
              }),
            }),
          })
          const run = Effect.fn('GoogleTest.verifyReturns')(function* () {
            const store = yield* ConnectionStore
            const first = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'First',
              shared: false,
            })
            const second = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Second',
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
            const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
            const send = Effect.fn('GoogleTest.return')(function* (state: string) {
              return yield* handle.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(
                    // No Vivid session: the state is what names the sign-in and its Person.
                    new Request(
                      new URL(`${googleReturnPath}?${state}&code=private-code`, config.PUBLIC_URL),
                    ),
                  ),
                ),
              )
            })
            const firstState = new URL(first.address).searchParams.get('state')
            const secondState = new URL(second.address).searchParams.get('state')
            const generic = new URL('/settings/connections', config.PUBLIC_URL).href
            expect((yield* send(`state=${firstState}&state=${secondState}`)).headers.location).toBe(
              generic,
            )
            expect((yield* send(`state=${crypto.randomUUID()}`)).headers.location).toBe(generic)
            expect(yield* Ref.get(probe.signIns)).toBe(0)
            const completed = yield* send(`state=${secondState}`)
            expect(completed.headers.location).toBe(
              new URL(`/settings/connections?connected=${second.connection.id}`, config.PUBLIC_URL)
                .href,
            )
            expect((yield* store.get(ownerActor, first.connection.id)).status).toBe(
              'needs-authorization',
            )
            expect(yield* Ref.get(probe.signIns)).toBe(1)
            expect((yield* store.get(ownerActor, second.connection.id)).status).toBe('ready')
            expect((yield* send(`state=${secondState}`)).headers.location).toBe(generic)
            expect(yield* Ref.get(probe.signIns)).toBe(1)
          })
          yield* Effect.gen(function* () {
            // Capture the callback Executor that records the exact concurrent sign-in targets.
            const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
            return yield* run().pipe(Effect.provide(context))
          }).pipe(Effect.scoped, Effect.provideService(Executor, google))
        }),
    )
  })
})
