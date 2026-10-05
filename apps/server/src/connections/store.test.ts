import { describe, expect, layer } from '@effect/vitest'
import { Context, Deferred, Effect, Redacted, Ref, Layer, Fiber, Option, Tracer } from 'effect'
import {
  AuditEvent,
  ConnectionStep,
  Workspace,
  ConnectionState,
  Forbidden,
  NotFound,
  InvalidRequest,
  ServiceUnavailable,
  ServiceCatalog,
  ServiceAuthorization,
  ServiceId,
} from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import * as TestClock from 'effect/testing/TestClock'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { membershipTable } from '../companies/tables.ts'
import { auditEntries } from '../audit/tables.ts'
import { auditLayer } from '../audit/record.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  Executor,
  ExecutorRejected,
  ExecutorSignInRequired,
  ExecutorServiceEntry,
  connectionSetupMessage,
} from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'

describe.skipIf(!testDatabaseConfigured)('Connection ownership', () => {
  layer(connectionTestLayer)((it) => {
    /** Build the real store in an ended construction span, then read under a fresh caller.
     * Tracer.NativeSpan records actual Effect.fn parenting without replacing store or SQL work.
     */
    it.effect('parents store operations to the caller after the construction span ends', () =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          },
        })
        yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          // rc.116 Layer.ts:3891 gives this construction its own memo map; the harness already
          // built this same store, whose reuse would skip construction under the recording tracer.
          const services = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.withSpan('Connections.Test.construction'),
          )
          const construction = spans.find((span) => span.name === 'Connections.makeStore')
          if (construction === undefined) return expect.fail('Store construction span is missing')
          expect(construction.status._tag).toBe('Ended')
          const store = Context.get(services, ConnectionStore)
          expect(
            yield* store.records(ownerActor).pipe(Effect.withSpan('Connections.Test.caller')),
          ).toEqual([])
          const caller = spans.find((span) => span.name === 'Connections.Test.caller')
          const operation = spans.find((span) => span.name === 'Connections.listRecords')
          if (caller === undefined || operation === undefined)
            return expect.fail('Caller or operation span is missing')
          expect(Option.map(operation.parent, (parent) => parent.spanId)).toEqual(
            Option.some(caller.spanId),
          )
          return undefined
        }).pipe(Effect.provide(Layer.succeed(Tracer.Tracer, tracer)))
      }),
    )

    it.effect('revokes provider resources when the real product insert is rejected', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const database = yield* Database
        const probe = yield* ConnectionProbe
        const removals = yield* Ref.get(probe.removals)
        yield* database.run(
          database.delete(personTable).where(eq(personTable.id, ownerActor.person.id)),
        )
        const failure = yield* (yield* ConnectionStore)
          .begin(ownerActor, { service: serviceId, label: 'Rejected insert', shared: false })
          .pipe(Effect.flip)
        expect(failure._tag).toBe('DatabaseConstraintViolation')
        expect(yield* Ref.get(probe.removals)).toBe(removals + 1)
        expect((yield* (yield* ConnectionStore).list(ownerActor)).connections).toEqual([])
      }),
    )
    for (const configured of [false, true]) {
      it.effect(`starts no setup sweep with Executor configured ${configured}`, () =>
        Effect.gen(function* () {
          const executor = yield* Executor
          const calls = yield* Ref.make(0)
          const controlled = Executor.of({
            ...executor,
            configured,
            catalog: () =>
              Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(executor.catalog())),
            authorization: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(
                  executor.authorization({
                    service: serviceId,
                    returnAddress: 'https://example.test/return',
                  }),
                ),
              ),
          })
          yield* Effect.gen(function* () {
            yield* ConnectionStore
            yield* TestClock.adjust('1 hour')
            expect(yield* Ref.get(calls)).toBe(0)
          }).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, controlled),
          )
        }),
      )
    }

    it.effect('preserves the insert failure when provider compensation also fails', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const database = yield* Database
        const executor = yield* Executor
        yield* database.run(
          database.delete(personTable).where(eq(personTable.id, ownerActor.person.id)),
        )
        const failed = Executor.of({
          ...executor,
          remove: () =>
            Effect.fail(
              new ServiceUnavailable({ service: 'connections', message: 'Cleanup failed' }),
            ),
        })
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).begin(ownerActor, {
            service: serviceId,
            label: 'Rejected',
            shared: false,
          })
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, failed),
          Effect.flip,
        )
        expect(failure._tag).toBe('DatabaseConstraintViolation')
      }),
    )

    it.effect('resumes shared sign-in for another admin and scopes its return to that Person', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const outsider = (yield* fixture()).ownerActor
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const database = yield* Database
        yield* database.run(
          database
            .update(membershipTable)
            .set({ role: 'admin' })
            .where(eq(membershipTable.userId, memberActor.person.id)),
        )
        if (!Workspace.guards.Company(memberActor.workspace))
          expect.fail('Company fixture required')
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
          label: 'Shared',
          shared: true,
        })
        const original = yield* store.get(ownerActor, begun.connection.id)
        const executor = yield* Executor
        const renewed = Executor.of({
          ...executor,
          reauthorize: (input) => {
            expect(input.subject).toBe(admin.person.id)
            return executor.reauthorize(input)
          },
        })
        yield* Effect.gen(function* () {
          const resumedStore = yield* ConnectionStore
          const resumed = yield* resumedStore.resume(admin, begun.connection.id)
          expect(resumed._tag).toBe('OpenSignIn')
          const retained = yield* resumedStore.get(admin, begun.connection.id)
          expect(retained).toMatchObject({
            personId: admin.person.id,
            companyId: original.companyId,
            createdAt: original.createdAt,
            references: { owner: original.references.owner },
          })
          for (const actor of [ownerActor, outsider]) {
            expect(
              yield* resumedStore
                .callback(
                  actor,
                  begun.connection.id,
                  Redacted.make(`https://example.test/return?state=${begun.connection.id}`),
                )
                .pipe(Effect.flip),
            ).toBeInstanceOf(NotFound)
          }
          const personal = {
            ...admin,
            workspace: Workspace.cases.Personal.make({}),
            threadId: Option.none(),
          }
          expect(
            (yield* resumedStore.callback(
              personal,
              begun.connection.id,
              Redacted.make(`https://example.test/return?state=${begun.connection.id}`),
            ))._tag,
          ).toBe('Ready')
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, renewed),
        )
        yield* Ref.set(probe.step, 'Done')
      }),
    )

    it.effect('rejects a resumed return when its admin leaves the owning Company', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const database = yield* Database
        const probe = yield* ConnectionProbe
        const store = yield* ConnectionStore
        yield* database.run(
          database
            .update(membershipTable)
            .set({ role: 'admin' })
            .where(eq(membershipTable.userId, memberActor.person.id)),
        )
        if (!Workspace.guards.Company(memberActor.workspace))
          expect.fail('Company fixture required')
        const admin = {
          ...memberActor,
          workspace: Workspace.cases.Company.make({
            company: memberActor.workspace.company,
            role: 'admin',
          }),
        }
        yield* Ref.set(probe.step, 'OpenSignIn')
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Shared',
          shared: true,
        })
        yield* store.resume(admin, step.connection.id)
        const before = yield* Ref.get(probe.signIns)
        yield* database.run(
          database.delete(membershipTable).where(eq(membershipTable.userId, admin.person.id)),
        )
        expect(
          (yield* store
            .callback(
              admin,
              step.connection.id,
              Redacted.make(`https://example.test/return?state=${step.connection.id}`),
            )
            .pipe(Effect.flip))._tag,
        ).toBe('Forbidden')
        expect(yield* Ref.get(probe.signIns)).toBe(before)
        yield* Ref.set(probe.step, 'Done')
      }),
    )

    it.effect('serializes the same Connection while another Connection resumes independently', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
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
        const executor = yield* Executor
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const calls = yield* Ref.make(0)
        const controlled = Executor.of({
          ...executor,
          reauthorize: Effect.fn('Executor.Test.blockResume')(function* (input) {
            if (input.connectionId === first.connection.id) {
              yield* Ref.update(calls, (count) => count + 1)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return yield* executor.reauthorize(input)
          }),
        })
        yield* Effect.gen(function* () {
          const scoped = yield* ConnectionStore
          const slow = yield* scoped.resume(ownerActor, first.connection.id).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          const repeated = yield* scoped
            .resume(ownerActor, first.connection.id)
            .pipe(Effect.forkChild)
          expect((yield* scoped.resume(ownerActor, second.connection.id))._tag).toBe('OpenSignIn')
          expect(yield* Ref.get(calls)).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(slow)
          yield* Fiber.join(repeated)
          expect(yield* Ref.get(calls)).toBe(2)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, controlled),
        )
        yield* Ref.set(probe.step, 'Done')
      }),
    )
    it.effect(
      'keeps personal accounts private across workspaces and stores opaque owner references',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, personalActor } = yield* fixture()
          const store = yield* ConnectionStore
          const step = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Personal account',
            shared: false,
          })
          expect((yield* store.list(personalActor)).connections.map((row) => row.id)).toContain(
            step.connection.id,
          )
          expect((yield* store.list(memberActor)).connections).toEqual([])
          expect(
            yield* store.get(memberActor, step.connection.id).pipe(Effect.flip),
          ).toBeInstanceOf(NotFound)
          const row = yield* store.get(ownerActor, step.connection.id)
          expect(row.references.owner).toBe(`p-${ownerActor.person.id}`)
          expect(JSON.stringify(step)).not.toContain('references')
          yield* store.remove(ownerActor, step.connection.id)
          expect((yield* store.list(ownerActor)).connections).toEqual([])
        }),
    )
    it.effect('reserves shared management for admins, including the row creator', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const before = yield* Ref.get(probe.begins)
        expect(
          yield* store
            .begin(memberActor, { service: serviceId, label: 'Shared account', shared: true })
            .pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        expect(yield* Ref.get(probe.begins)).toBe(before)
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Shared account',
          shared: true,
        })
        expect((yield* store.list(memberActor)).connections).toHaveLength(1)
        expect(
          yield* store.remove(memberActor, step.connection.id).pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        const row = yield* store.get(memberActor, step.connection.id)
        expect(row.references.owner).toBe(`c-${row.companyId}`)
        yield* store.remove(ownerActor, step.connection.id)
        const events = yield* Ref.get(probe.events)
        expect(events.slice(-2)).toMatchObject([
          AuditEvent.cases.ConnectionAdded.make({ service: 'Records', shared: true }),
          AuditEvent.cases.ConnectionRemoved.make({ service: 'Records', shared: true }),
        ])
      }),
    )
    it.effect('returns stored accounts while the Executor catalog is unavailable', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Offline catalog',
          shared: false,
        })
        const executor = yield* Executor
        const probe = yield* ConnectionProbe
        const unavailable = Executor.of({
          ...executor,
          catalog: Effect.fn('Executor.Test.unavailable')(function* () {
            yield* Ref.update(probe.catalogs, (count) => count + 1)
            return yield* Effect.fail(
              new ServiceUnavailable({ service: 'connections', message: 'Unavailable' }),
            )
          }),
        })
        yield* Effect.gen(function* () {
          const offlineStore = yield* ConnectionStore
          const listed = yield* offlineStore.list(ownerActor)
          expect(Object.keys(listed)).toEqual(['connections'])
          expect(listed.connections.map((row) => row.id)).toContain(step.connection.id)
          const afterList = yield* Ref.get(probe.catalogs)
          yield* offlineStore.list(ownerActor)
          expect(yield* Ref.get(probe.catalogs)).toBe(afterList)
          expect(yield* offlineStore.find('Records')).toEqual(
            ServiceCatalog.cases.Unavailable.make({}),
          )
          expect(yield* Ref.get(probe.catalogs)).toBe(afterList + 1)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, unavailable),
        )
      }),
    )
    /** List failures are paced like catalog downloads; successful reads must still see refreshed sites. */
    it.effect('recovers catalog icons after backoff and observes subsequent catalog changes', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const step = yield* (yield* ConnectionStore).begin(ownerActor, {
          service: serviceId,
          label: 'Catalog recovery',
          shared: false,
        })
        const executor = yield* Executor
        const site = yield* Ref.make<Option.Option<string>>(Option.none())
        const calls = yield* Ref.make(0)
        const controlled = Executor.of({
          ...executor,
          catalog: Effect.fn('Executor.Test.recoveringCatalog')(function* () {
            yield* Ref.update(calls, (count) => count + 1)
            const domain = yield* Ref.get(site)
            if (Option.isNone(domain))
              return yield* Effect.fail(
                ServiceUnavailable.make({ service: 'connections', message: 'Unavailable' }),
              )
            return (yield* executor.catalog()).map((entry) =>
              ExecutorServiceEntry.make({ ...entry, domain: domain.value }),
            )
          }),
        })
        yield* Effect.gen(function* () {
          const store = yield* ConnectionStore
          expect((yield* store.list(ownerActor)).connections).toMatchObject([
            { id: step.connection.id, mark: null },
          ])
          yield* Ref.set(site, Option.some('workspace.google.com'))
          yield* TestClock.adjust('29 seconds')
          expect((yield* store.list(ownerActor)).connections).toMatchObject([
            { id: step.connection.id, mark: null },
          ])
          expect(yield* Ref.get(calls)).toBe(1)
          yield* TestClock.adjust('1 second')
          expect((yield* store.list(ownerActor)).connections).toMatchObject([
            {
              id: step.connection.id,
              mark: 'https://www.google.com/s2/favicons?domain=google.com',
            },
          ])
          expect(yield* Ref.get(calls)).toBe(2)
          yield* Ref.set(site, Option.some('deepwiki.com'))
          expect((yield* store.list(ownerActor)).connections).toMatchObject([
            {
              id: step.connection.id,
              mark: 'https://www.google.com/s2/favicons?domain=deepwiki.com',
            },
          ])
          expect(yield* Ref.get(calls)).toBe(3)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, controlled),
        )
      }),
    )
    it.effect('searches the full catalog and preserves failures other than unavailability', () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore
        const found = yield* store.find(' records ')
        expect(ServiceCatalog.guards.Ready(found)).toBe(true)
        expect(found).toMatchObject({
          total: 1,
          services: [{ name: 'Records' }],
        })
        expect(yield* store.find('Absent')).toEqual(
          ServiceCatalog.cases.Ready.make({ total: 1, services: [] }),
        )
        const executor = yield* Executor
        const rejected = Executor.of({
          ...executor,
          catalog: Effect.fn('Executor.Test.rejectedCatalog')(() =>
            Effect.fail(
              ExecutorRejected.make({
                service: 'connections',
                tool: null,
                message: 'Catalog refused',
              }),
            ),
          ),
        })
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).find('Records')
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, rejected),
          Effect.flip,
        )
        expect(failure).toBeInstanceOf(InvalidRequest)
      }),
    )
    it.effect(
      'lists unavailable setup and refuses begin before any account or row is created',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const executor = yield* Executor
          const probe = yield* ConnectionProbe
          const before = yield* Ref.get(probe.begins)
          const setupRequired = Executor.of({
            ...executor,
            catalog: Effect.fn('Executor.Test.setupCatalog')(function* () {
              return (yield* executor.catalog()).map((entry) =>
                ExecutorServiceEntry.make({
                  ...entry,
                  authorization: ServiceAuthorization.cases.SetupRequired.make({}),
                }),
              )
            }),
            authorization: Effect.fn('Executor.Test.setupRequired')(() =>
              Effect.succeed(ServiceAuthorization.cases.SetupRequired.make({})),
            ),
          })
          yield* Effect.gen(function* () {
            const store = yield* ConnectionStore
            const found = yield* store.find('records')
            expect(found).toHaveProperty(
              'services.0.authorization',
              ServiceAuthorization.cases.SetupRequired.make({}),
            )
            const prior = yield* store.list(ownerActor)
            expect(
              yield* store
                .begin(ownerActor, {
                  service: serviceId,
                  label: 'Setup unavailable',
                  shared: false,
                })
                .pipe(Effect.flip),
            ).toEqual(new InvalidRequest({ message: connectionSetupMessage }))
            expect(yield* store.list(ownerActor)).toEqual(prior)
            expect(yield* Ref.get(probe.begins)).toBe(before)
          }).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, setupRequired),
          )
        }),
    )
    it.effect('searches optimistic catalog hints without waiting for inspection', () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const gate = yield* Deferred.make<void>()
        const entries = Array.from({ length: 30 }, (_, index) =>
          ExecutorServiceEntry.make({
            id: ServiceId.make(`service-${index}`),
            name: `Records ${index}`,
            description: 'Records',
            domain: null,
            authorization:
              index < 24
                ? ServiceAuthorization.cases.SignIn.make({})
                : ServiceAuthorization.cases.None.make({}),
          }),
        )
        const inspection = Executor.of({
          ...executor,
          catalog: Effect.fn('Executor.Test.largeCatalog')(() => Effect.succeed(entries)),
          authorization: Effect.fn('Executor.Test.inspect')(function* () {
            yield* Deferred.await(gate)
            return ServiceAuthorization.cases.SetupRequired.make({})
          }),
        })
        const found = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).find('records')
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, inspection),
        )
        expect(yield* Deferred.isDone(gate)).toBe(false)
        expect(ServiceCatalog.guards.Ready(found)).toBe(true)
        if (ServiceCatalog.guards.Ready(found)) {
          expect(found.total).toBe(30)
          expect(found.services).toHaveLength(24)
          expect(found.services.map((service) => service.id)).toEqual(
            entries.slice(0, 24).map((service) => service.id),
          )
        }
      }),
    )
    it.effect(
      'allows only the initiating Person to complete sign-in after a workspace switch',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, personalActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const step = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Company sign-in',
            shared: true,
          })
          expect(step._tag).toBe('OpenSignIn')
          const before = yield* Ref.get(probe.signIns)
          expect(
            yield* store
              .callback(
                memberActor,
                step.connection.id,
                Redacted.make(`https://example.test/return?state=${step.connection.id}`),
              )
              .pipe(Effect.flip),
          ).toBeInstanceOf(NotFound)
          expect(yield* Ref.get(probe.signIns)).toBe(before)
          const ready = yield* store.callback(
            { ...personalActor, by: 'person' },
            step.connection.id,
            Redacted.make(`https://example.test/return?state=${step.connection.id}`),
          )
          expect(ConnectionState.guards.Ready(ready)).toBe(true)
          expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('ready')
          expect(yield* Ref.get(probe.signIns)).toBe(before + 1)
          yield* Ref.set(probe.step, 'Done')
        }),
    )
    it.effect('rejects a shared callback after the initiating admin is demoted', () =>
      Effect.gen(function* () {
        const { ownerActor, personalActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Shared sign-in',
          shared: true,
        })
        const row = yield* store.get(ownerActor, step.connection.id)
        if (row.companyId === null) expect.fail('Shared Connection must have a Company')
        const database = yield* Database
        const before = yield* Ref.get(probe.signIns)
        yield* database.run(
          database
            .update(membershipTable)
            .set({ role: 'member' })
            .where(
              and(
                eq(membershipTable.userId, ownerActor.person.id),
                eq(membershipTable.companyId, row.companyId),
              ),
            ),
        )
        expect(
          yield* store
            .callback(
              { ...personalActor, by: 'person' },
              step.connection.id,
              Redacted.make(`https://example.test/return?state=${step.connection.id}`),
            )
            .pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        expect(yield* Ref.get(probe.signIns)).toBe(before)
        expect((yield* store.get(ownerActor, step.connection.id)).status).toBe(
          'needs-authorization',
        )
        yield* Ref.set(probe.step, 'Done')
      }),
    )
    it.effect(
      'audits shared callbacks in their Company and personal callbacks in personal space',
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const shared = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Shared sign-in',
            shared: true,
          })
          const personal = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Personal sign-in',
            shared: false,
          })
          const database = yield* Database
          const expected = (yield* store.get(ownerActor, shared.connection.id)).companyId
          yield* Effect.gen(function* () {
            const recorded = yield* ConnectionStore
            yield* recorded.callback(
              { ...personalActor, by: 'person' },
              shared.connection.id,
              Redacted.make(`https://example.test/return?state=${shared.connection.id}`),
            )
            yield* recorded.callback(
              ownerActor,
              personal.connection.id,
              Redacted.make(`https://example.test/return?state=${personal.connection.id}`),
            )
          }).pipe(
            Effect.provide(connectionStoreLayer.pipe(Layer.provide(auditLayer)), { local: true }),
          )
          const rows = yield* database.run(
            database
              .select({ companyId: auditEntries.companyId })
              .from(auditEntries)
              .where(eq(auditEntries.personId, ownerActor.person.id)),
          )
          expect(rows.map((row) => row.companyId)).toEqual(expect.arrayContaining([expected, null]))
          expect(rows).toHaveLength(2)
          yield* Ref.set(probe.step, 'Done')
        }),
    )
    it.effect('does not persist a failed sign-in start and removes its pending resources', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
        const executor = yield* Executor
        const blocked = Executor.of({
          ...executor,
          begin: Effect.fn('Executor.Test.signInRequired')(function* (input) {
            const step = yield* executor.begin(input)
            return yield* Effect.fail(
              ExecutorSignInRequired.make({
                references: step.references,
                message: 'Sign-in could not start.',
              }),
            )
          }),
        })
        const before = yield* Ref.get(probe.removals)
        const events = yield* Ref.get(probe.events)
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).begin(ownerActor, {
            service: serviceId,
            label: 'Unavailable sign-in',
            shared: false,
          })
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, blocked),
          Effect.flip,
        )
        expect(failure._tag).toBe('InvalidRequest')
        expect((yield* store.list(ownerActor)).connections).toEqual([])
        expect(yield* Ref.get(probe.removals)).toBe(before + 1)
        expect(yield* Ref.get(probe.events)).toEqual(events)
        yield* Ref.set(probe.step, 'Done')
      }),
    )
    it.effect('leaves no row when cleanup of a failed sign-in start is unavailable', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const executor = yield* Executor
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
        const blocked = Executor.of({
          ...executor,
          begin: Effect.fn('Executor.Test.signInRequiredAgain')(function* (input) {
            const step = yield* executor.begin(input)
            return yield* Effect.fail(
              ExecutorSignInRequired.make({
                references: step.references,
                message: 'Sign-in could not start.',
              }),
            )
          }),
          remove: Effect.fn('Executor.Test.cleanupUnavailable')(() =>
            Effect.fail(
              ServiceUnavailable.make({ service: 'connections', message: 'Cleanup unavailable' }),
            ),
          ),
        })
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).begin(ownerActor, {
            service: serviceId,
            label: 'Unavailable sign-in',
            shared: false,
          })
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, blocked),
          Effect.flip,
        )
        expect(failure._tag).toBe('InvalidRequest')
        expect(failure.message).toBe('Sign-in could not start.')
        expect((yield* store.list(ownerActor)).connections).toEqual([])
        yield* Ref.set(probe.step, 'Done')
      }),
    )
    it.effect('completes key entry without persisting supplied credential fields', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'EnterKey')
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Key account',
          shared: false,
        })
        expect(step._tag).toBe('EnterKey')
        if (ConnectionStep.guards.EnterKey(step))
          expect(step.fields).toEqual([{ name: 'key', label: 'Key' }])
        const connection = yield* store.complete(ownerActor, {
          id: step.connection.id,
          fields: { key: Redacted.make('credential-never-stored') },
        })
        expect(connection.state._tag).toBe('Ready')
        expect(JSON.stringify(yield* store.get(ownerActor, connection.id))).not.toContain(
          'credential-never-stored',
        )
        yield* Ref.set(probe.step, 'Done')
      }),
    )
  })
})
