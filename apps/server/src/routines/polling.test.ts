import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { InvalidRequest, RoutineId, RoutineTrigger } from '@vivid/contracts'
import { Effect, Layer, Ref } from 'effect'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  ExecutorAccountId,
  ExecutorCallOutcome,
  ExecutorTool,
  ExecutorReferences,
} from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import { connections } from '../connections/tables.ts'
import { encodeReferences } from '../connections/records.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from '../connections/testing.ts'
import { integrationPollingServiceLayer } from '../connections/watch.ts'
import {
  IntegrationWatch,
  IntegrationCursorLost,
  IntegrationRevoked,
  IntegrationReadFailed,
  WatchCursor,
} from './watch.ts'

const pollingLayer = integrationPollingServiceLayer.pipe(Layer.provideMerge(connectionTestLayer))
const filter = {
  input: { from: 'dami@example.test' },
  itemsPath: ['messages'],
  idPath: ['id'],
  newestFirst: true,
}
/** A real Connection and the real polling Layer meet at the controlled Executor provider boundary. */
const setup = Effect.fn('PollingTest.setup')(function* () {
  const { ownerActor } = yield* fixture()
  const store = yield* ConnectionStore
  const probe = yield* ConnectionProbe
  yield* Ref.set(probe.tools, [
    ExecutorTool.make({
      name: 'listMail',
      description: 'List matching email, newest first.',
      effect: 'read',
      input: { type: 'object' },
    }),
    ExecutorTool.make({
      name: 'sendMail',
      description: 'Send email.',
      effect: 'write',
      input: { type: 'object' },
    }),
  ])
  const connected = yield* store.begin(ownerActor, {
    from: 'Web',
    service: serviceId,
    name: 'Work',
    shared: false,
  })
  yield* Ref.set(
    probe.outcome,
    ExecutorCallOutcome.cases.Completed.make({
      value: { messages: [{ id: 'baseline', body: 'Old email' }] },
    }),
  )
  yield* Ref.set(probe.calls, 0)
  const trigger = RoutineTrigger.cases.Integration.make({
    account: 'Records (Work)',
    event: 'listMail',
    filter,
  })
  return { ownerActor, probe, connected, trigger, watcher: yield* IntegrationWatch }
})

/** These claims exercise the concrete Layer, including current read classification and cursor gaps. */
describe.skipIf(!testDatabaseConfigured)('Integration polling adapter', () => {
  layer(pollingLayer)((it) => {
    it.effect('discovers actual read-only operations and removes private account selectors', () =>
      Effect.gen(function* () {
        const { ownerActor, probe, connected, watcher } = yield* setup()
        const row = yield* (yield* ConnectionStore).get(ownerActor, connected.connection.id)
        const account = ExecutorAccountId.make('PRIVATE-provider-account')
        const references = ExecutorReferences.cases.Authorized.make({
          service: row.references.service,
          app: row.references.app,
          profile: row.references.profile,
          owner: row.references.owner,
          appOwnership: row.references.appOwnership,
          account,
        })
        yield* (yield* Database).run(
          (yield* Database)
            .update(connections)
            .set({ references: yield* encodeReferences(references) })
            .where(eq(connections.id, connected.connection.id)),
        )
        yield* Ref.set(probe.tools, [
          ExecutorTool.make({
            name: 'listMail',
            description: 'List mail',
            effect: 'read',
            input: {
              type: 'object',
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    accountId: { type: 'string', const: account },
                    input: { type: 'object', properties: { from: { type: 'string' } } },
                  },
                },
              ],
            },
          }),
        ])
        const discovered = yield* watcher.discover(ownerActor, 'Records (Work)')
        expect(discovered.events.map((event) => event.event)).toEqual(['listMail'])
        expect(JSON.stringify(discovered)).not.toContain(account)
        expect(JSON.stringify(discovered)).not.toContain(connected.connection.id)
        expect(JSON.stringify(discovered)).not.toContain('accountId')
      }),
    )

    it.effect(
      'establishes a baseline then reads one tool and returns each new item oldest first',
      () =>
        Effect.gen(function* () {
          const { ownerActor, probe, watcher, trigger } = yield* setup()
          const watch = yield* watcher.prepare(ownerActor, trigger)
          expect(watch.intervalMillis).toBe(300_000)
          expect(WatchCursor.guards.Window(watch.cursor)).toBe(true)
          yield* Ref.set(probe.calls, 0)
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Completed.make({
              value: {
                messages: [
                  { id: '3', body: 'Third' },
                  { id: '2', body: 'Second' },
                  { id: '1', body: 'First' },
                  { id: 'baseline', body: 'Old email' },
                ],
              },
            }),
          )
          const batch = yield* watcher.newItems({
            routineId: RoutineId.make('test-routine'),
            personId: ownerActor.person.id,
            companyId: null,
            watch,
          })
          expect(batch.items.map((item) => item.id)).toEqual(['1', '2', '3'])
          expect(batch.items.map((item) => item.content)).toEqual([
            { id: '1', body: 'First' },
            { id: '2', body: 'Second' },
            { id: '3', body: 'Third' },
          ])
          expect(yield* Ref.get(probe.calls)).toBe(1)
          const repeated = yield* watcher.newItems({
            routineId: RoutineId.make('test-routine'),
            personId: ownerActor.person.id,
            companyId: null,
            watch: { ...watch, cursor: batch.cursor },
          })
          expect(repeated.items).toEqual([])
        }),
    )

    it.effect(
      'does not skip items when its high-water id falls outside the observation window',
      () =>
        Effect.gen(function* () {
          const { ownerActor, probe, watcher, trigger } = yield* setup()
          const watch = yield* watcher.prepare(ownerActor, trigger)
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Completed.make({
              value: { messages: [{ id: 'later', body: 'New email' }] },
            }),
          )
          expect(
            yield* watcher
              .newItems({
                routineId: RoutineId.make('test-routine'),
                personId: ownerActor.person.id,
                companyId: null,
                watch,
              })
              .pipe(Effect.flip),
          ).toBeInstanceOf(IntegrationCursorLost)
        }),
    )

    it.effect(
      'a new item below the high-water mark surfaces a gap and re-baselines without replay',
      () =>
        Effect.gen(function* () {
          const { ownerActor, probe, watcher, trigger } = yield* setup()
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Completed.make({
              value: { messages: [{ id: 'head' }, { id: 'older' }] },
            }),
          )
          const watch = yield* watcher.prepare(ownerActor, trigger)
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Completed.make({
              value: {
                messages: [{ id: 'head' }, { id: 'imported-with-old-date' }, { id: 'older' }],
              },
            }),
          )
          const input = {
            routineId: RoutineId.make('test-routine'),
            personId: ownerActor.person.id,
            companyId: null,
            watch,
          }
          const failure = yield* watcher.newItems(input).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(IntegrationCursorLost)
          if (!(failure instanceof IntegrationCursorLost))
            expect.fail('A typed ordering gap is required')
          expect(failure.reason).toBe('Ordering')
          expect(
            (yield* watcher.newItems({ ...input, watch: { ...watch, cursor: failure.cursor } }))
              .items,
          ).toEqual([])
        }),
    )

    it.effect(
      'uses the private binding after a label changes and refuses revoked Connections before calling',
      () =>
        Effect.gen(function* () {
          const { ownerActor, probe, connected, watcher, trigger } = yield* setup()
          const watch = yield* watcher.prepare(ownerActor, trigger)
          const database = yield* Database
          yield* database.run(
            database
              .update(connections)
              .set({ name: 'Renamed', status: 'needs-authorization' })
              .where(eq(connections.id, connected.connection.id)),
          )
          yield* Ref.set(probe.calls, 0)
          expect(
            yield* watcher
              .newItems({
                routineId: RoutineId.make('test-routine'),
                personId: ownerActor.person.id,
                companyId: null,
                watch,
              })
              .pipe(Effect.flip),
          ).toBeInstanceOf(IntegrationRevoked)
          expect(yield* Ref.get(probe.calls)).toBe(0)
        }),
    )

    it.effect(
      'keeps a watch on its own account when that account is renamed, and takes a new baseline',
      () =>
        Effect.gen(function* () {
          const { ownerActor, watcher, trigger, connected } = yield* setup()
          const watch = yield* watcher.prepare(ownerActor, trigger)
          const store = yield* ConnectionStore
          // A second account on the service, then the watched one is renamed.
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Personal',
            shared: false,
          })
          yield* store.rename(ownerActor, { id: connected.connection.id, name: 'Office' })
          // The name the trigger was made under is nobody's now: it cannot be resolved again.
          expect(yield* watcher.prepare(ownerActor, trigger).pipe(Effect.flip)).toBeInstanceOf(
            InvalidRequest,
          )
          // Switching the Routine on again goes back to the Connection the watch is bound to.
          const rebased = yield* watcher.rebase(ownerActor, watch)
          expect(rebased.connectionId).toBe(connected.connection.id)
          expect(rebased.trigger).toMatchObject({
            account: 'Records (Office)',
            event: 'listMail',
          })
          expect(rebased.cursor).toEqual(watch.cursor)
        }),
    )

    it.effect('supports one-minute polling and rejects shorter intervals and write tools', () =>
      Effect.gen(function* () {
        const { ownerActor, watcher, trigger } = yield* setup()
        const minute = yield* watcher.prepare(ownerActor, {
          ...trigger,
          filter: { ...filter, intervalMinutes: 1 },
        })
        expect(minute.intervalMillis).toBe(60_000)
        expect(
          yield* watcher
            .prepare(ownerActor, { ...trigger, filter: { ...filter, intervalMinutes: 0 } })
            .pipe(Effect.flip),
        ).toBeInstanceOf(InvalidRequest)
        expect(
          yield* watcher.prepare(ownerActor, { ...trigger, event: 'sendMail' }).pipe(Effect.flip),
        ).toBeInstanceOf(InvalidRequest)
      }),
    )

    it.effect(
      'a failed Integration produces a failure reason without calling a provider tool',
      () =>
        Effect.gen(function* () {
          const { ownerActor, probe, connected, watcher, trigger } = yield* setup()
          const watch = yield* watcher.prepare(ownerActor, trigger)
          const database = yield* Database
          yield* database.run(
            database
              .update(connections)
              .set({ status: 'failed' })
              .where(eq(connections.id, connected.connection.id)),
          )
          yield* Ref.set(probe.calls, 0)
          expect(
            yield* watcher
              .newItems({
                routineId: RoutineId.make('test-routine'),
                personId: ownerActor.person.id,
                companyId: null,
                watch,
              })
              .pipe(Effect.flip),
          ).toBeInstanceOf(IntegrationReadFailed)
          expect(yield* Ref.get(probe.calls)).toBe(0)
        }),
    )
  })
})
