import { describe, expect, layer } from '@effect/vitest'
import { Effect, Logger, Ref } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http'
import { ConnectionId, ServiceUnavailable, Workspace, type PersonId } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { eq } from 'drizzle-orm'
import { membershipTable } from '../companies/tables.ts'
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
      'returns a resumed shared Connection only for its current admin in its owning Company',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const outsider = (yield* fixture()).ownerActor
          const database = yield* Database
          const config = yield* ServerConfig
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          if (!Workspace.guards.Company(memberActor.workspace))
            expect.fail('Company fixture required')
          yield* database.run(
            database
              .update(membershipTable)
              .set({ role: 'admin' })
              .where(eq(membershipTable.userId, memberActor.person.id)),
          )
          const admin = {
            ...memberActor,
            by: 'person' as const,
            workspace: Workspace.cases.Company.make({
              company: memberActor.workspace.company,
              role: 'admin',
            }),
          }
          yield* Ref.set(probe.step, 'OpenSignIn')
          const begun = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Shared return',
            shared: true,
          })
          yield* store.resume(admin, begun.connection.id)
          const handle = yield* HttpRouter.toHttpEffect(connectionReturnRoutes)
          /** Real bearer sessions exercise authentication, row scope and fresh Company membership. */
          const send = Effect.fn('Connections.Test.resumedReturn')(function* (personId: PersonId) {
            const token = crypto.randomUUID()
            yield* database.run(
              database.insert(sessionTable).values({
                id: crypto.randomUUID(),
                token,
                userId: personId,
                expiresAt: new Date(Date.UTC(2099, 0, 1)),
              }),
            )
            return yield* handle.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    new URL(
                      `/api/connections/return/${begun.connection.id}?code=return-secret`,
                      config.PUBLIC_URL,
                    ),
                    {
                      headers: { authorization: `Bearer ${token}` },
                    },
                  ),
                ),
              ),
            )
          })
          const before = yield* Ref.get(probe.signIns)
          for (const personId of [ownerActor.person.id, outsider.person.id])
            expect((yield* send(personId)).headers.location).toBe(
              new URL(`/settings/connections?failed=${begun.connection.id}`, config.PUBLIC_URL)
                .href,
            )
          expect(yield* Ref.get(probe.signIns)).toBe(before)
          expect((yield* send(admin.person.id)).headers.location).toBe(
            new URL(`/settings/connections?connected=${begun.connection.id}`, config.PUBLIC_URL)
              .href,
          )
          expect(yield* Ref.get(probe.signIns)).toBe(before + 1)
          // A new return still requires current admin authority, even if the session stays valid.
          yield* store.notReady(admin, yield* store.get(admin, begun.connection.id))
          yield* store.resume(admin, begun.connection.id)
          yield* database.run(
            database
              .update(membershipTable)
              .set({ role: 'member' })
              .where(eq(membershipTable.userId, admin.person.id)),
          )
          expect((yield* send(admin.person.id)).headers.location).toBe(
            new URL(`/settings/connections?failed=${begun.connection.id}`, config.PUBLIC_URL).href,
          )
          expect(yield* Ref.get(probe.signIns)).toBe(before + 1)
          yield* Ref.set(probe.step, 'Done')
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
