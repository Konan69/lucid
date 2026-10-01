import { describe, expect, layer } from '@effect/vitest'
import { Effect, Redacted, Ref } from 'effect'
import {
  AuditEvent,
  ConnectionStep,
  Forbidden,
  NotFound,
  ServiceUnavailable,
} from '@vivid/contracts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Executor } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'

describe.skipIf(!testDatabaseConfigured)('Connection ownership', () => {
  layer(connectionTestLayer)((it) => {
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
        const unavailable = Executor.of({
          ...executor,
          catalog: Effect.fn('Executor.Test.unavailable')(() =>
            Effect.fail(new ServiceUnavailable({ service: 'connections', message: 'Unavailable' })),
          ),
        })
        const listed = yield* Effect.gen(function* () {
          return yield* (yield* ConnectionStore).list(ownerActor)
        }).pipe(
          Effect.provide(connectionStoreLayer, { local: true }),
          Effect.provideService(Executor, unavailable),
        )
        expect(listed.services).toEqual([])
        expect(listed.connections.map((row) => row.id)).toContain(step.connection.id)
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
          expect(
            yield* store.callback(
              personalActor,
              step.connection.id,
              Redacted.make('https://example.test/return'),
            ),
          ).toBe(true)
          expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('ready')
          expect(yield* Ref.get(probe.signIns)).toBe(before + 1)
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
