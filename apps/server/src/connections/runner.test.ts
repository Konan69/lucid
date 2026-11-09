import { describe, expect, layer } from '@effect/vitest'
import { Layer, Effect, Ref, Option } from 'effect'
import {
  ActionTarget,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { membershipTable } from '../companies/tables.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Executor, ExecutorCallOutcome, ExecutorTransportFailure } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionRunner } from './tools.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'

/** A deliberate infrastructure fault Layer leaves the production PostgreSQL adapter in place
 * until the selected phase. These tests prove the runner's classification, not the driver seam.
 */
const failingDatabase = (
  database: typeof Database.Service,
  unavailable: Ref.Ref<boolean>,
  failure: DatabaseInfrastructureError,
) =>
  Database.of({
    _: database._,
    query: database.query,
    $with: database.$with,
    $cache: database.$cache,
    $count: database.$count.bind(database),
    with: database.with.bind(database),
    // Query builders live on Drizzle's prototype; bind them to their original authority.
    select: database.select.bind(database),
    selectDistinct: database.selectDistinct.bind(database),
    selectDistinctOn: database.selectDistinctOn.bind(database),
    insert: database.insert.bind(database),
    update: database.update.bind(database),
    delete: database.delete.bind(database),
    refreshMaterializedView: database.refreshMaterializedView.bind(database),
    execute: database.execute.bind(database),
    // A write in its own transaction (a sign-in change, which closes stale Approvals with it)
    // meets the same outage as a single statement.
    transaction: Effect.fn('Database.Test.transactionFailure')(function* <A, E, R>(
      operation: Parameters<typeof database.transaction<A, E, R>>[0],
    ) {
      if (yield* Ref.get(unavailable)) return yield* failure
      return yield* database.transaction(operation)
    }),
    run: Effect.fn('Database.Test.connectionFailure')(function* <A, E, R>(
      query: Effect.Effect<A, E, R>,
    ) {
      if (yield* Ref.get(unavailable)) return yield* failure
      return yield* database.run(query)
    }),
  })

/** Approved actions must retain uncertainty when persistence or the remote transport fails. */
describe.skipIf(!testDatabaseConfigured)('Approved Connection outcomes', () => {
  layer(connectionTestLayer)((it) => {
    for (const failure of [
      DatabaseUnavailable.make({ message: 'Database unavailable' }),
      DatabaseFailure.make({ message: 'Database failed' }),
      DatabaseConstraintViolation.make({ message: 'Database constraint violated' }),
    ]) {
      for (const phase of ['access', 'dispatched'] as const) {
        it.effect(`${failure._tag} during ${phase} is Unknown`, () =>
          Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const store = yield* ConnectionStore
            const probe = yield* ConnectionProbe
            const step = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Approved account',
              shared: false,
            })
            const unavailable = yield* Ref.make(phase === 'access')
            const database = yield* Database
            const executor = yield* Executor
            const calls = yield* Ref.get(probe.calls)
            const dispatch = {
              ...executor,
              as: (caller) => ({
                ...executor.as(caller),
                call: Effect.fn('Executor.Test.dispatchBeforePersistenceFailure')(function* () {
                  yield* Ref.update(probe.calls, (count) => count + 1)
                  yield* Ref.set(unavailable, true)
                  return ExecutorCallOutcome.cases.NotReady.make({})
                }),
              }),
            } satisfies Executor['Service']
            const outcome = yield* Effect.gen(function* () {
              // The store captures this phase-specific database failure before approved execution.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* connectionRunner({
                operation: Option.none(),
                person: ownerActor.person,
                workspace: ownerActor.workspace,
                target: ActionTarget.cases.Connection.make({
                  connectionId: step.connection.id,
                  account: 'Approved account',
                  tool: 'read',
                  input: {},
                }),
              }).pipe(Effect.provide(context))
            }).pipe(
              Effect.scoped,
              Effect.provideService(Database, failingDatabase(database, unavailable, failure)),
              Effect.provideService(Executor, dispatch),
            )
            expect(outcome._tag).toBe('Unknown')
            expect(yield* Ref.get(probe.calls)).toBe(calls + (phase === 'access' ? 0 : 1))
            expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('ready')
          }),
        )
      }
    }
    it.effect(
      'transport unavailability after dispatch is Unknown, while a missing Connection did not run',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Transport loss',
            shared: false,
          })
          const executor = yield* Executor
          const calls = yield* Ref.get(probe.calls)
          const unavailable = {
            ...executor,
            as: (caller) => ({
              ...executor.as(caller),
              call: Effect.fn('Executor.Test.dispatchedUnavailable')(function* () {
                yield* Ref.update(probe.calls, (count) => count + 1)
                return yield* ExecutorTransportFailure.make({
                  service: 'connections',
                  tool: 'read',
                })
              }),
            }),
          } satisfies Executor['Service']
          const input = {
            operation: Option.none(),
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Transport loss',
              tool: 'read',
              input: {},
            }),
          }
          expect(
            (yield* connectionRunner(input).pipe(Effect.provideService(Executor, unavailable)))
              ._tag,
          ).toBe('Unknown')
          expect(yield* Ref.get(probe.calls)).toBe(calls + 1)
          yield* store.remove(ownerActor, step.connection.id)
          const missing = yield* connectionRunner(input)
          expect(missing._tag).toBe('Failed')
          expect(missing).toMatchObject({
            reason:
              'The integration is no longer available; check its authorization and your access.',
          })
          expect(yield* Ref.get(probe.calls)).toBe(calls + 1)
        }),
    )
    it.effect('revoked Company Membership proves an approved action did not run', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Private approved account',
          shared: false,
        })
        const database = yield* Database
        const calls = yield* Ref.get(probe.calls)
        yield* database.run(
          database.delete(membershipTable).where(eq(membershipTable.userId, ownerActor.person.id)),
        )
        const outcome = yield* connectionRunner({
          operation: Option.none(),
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          target: ActionTarget.cases.Connection.make({
            connectionId: step.connection.id,
            account: 'Private approved account',
            tool: 'read',
            input: {},
          }),
        })
        expect(outcome._tag).toBe('Failed')
        expect(outcome).toMatchObject({
          reason:
            'The integration is no longer available; check its authorization and your access.',
        })
        expect(yield* Ref.get(probe.calls)).toBe(calls)
      }),
    )
  })
})
