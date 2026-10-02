import { describe, expect, layer } from '@effect/vitest'
import { Deferred, Effect, Redacted, Ref, Layer } from 'effect'
import {
  AuditEvent,
  ConnectionStep,
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
    it.effect('starts no availability worker when the installation has no Executor', () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const calls = yield* Ref.make(0)
        const disabled = Executor.of({
          ...executor,
          configured: false,
          catalog: Effect.fn('Executor.Test.disabledCatalog')(() =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  ServiceUnavailable.make({ service: 'connections', message: 'Unconfigured' }),
                ),
              ),
            ),
          ),
        })
        yield* Effect.gen(function* () {
          yield* ConnectionStore
          yield* TestClock.adjust('1 hour')
          expect(yield* Ref.get(calls)).toBe(0)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, disabled),
        )
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
          const afterBackground = yield* Ref.get(probe.catalogs)
          yield* offlineStore.list(ownerActor)
          expect(yield* Ref.get(probe.catalogs)).toBe(afterBackground)
          expect(yield* offlineStore.find('Records')).toEqual(
            ServiceCatalog.cases.Unavailable.make({}),
          )
          expect(yield* Ref.get(probe.catalogs)).toBe(afterBackground + 1)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, unavailable),
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
          return yield* (yield* ConnectionStore).find('')
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
                Redacted.make('https://example.test/return'),
              )
              .pipe(Effect.flip),
          ).toBeInstanceOf(NotFound)
          expect(yield* Ref.get(probe.signIns)).toBe(before)
          const ready = yield* store.callback(
            { ...personalActor, by: 'person' },
            step.connection.id,
            Redacted.make('https://example.test/return'),
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
              Redacted.make('https://example.test/return'),
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
              Redacted.make('https://example.test/return'),
            )
            yield* recorded.callback(
              ownerActor,
              personal.connection.id,
              Redacted.make('https://example.test/return'),
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
        expect(failure._tag).toBe('ServiceUnavailable')
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
