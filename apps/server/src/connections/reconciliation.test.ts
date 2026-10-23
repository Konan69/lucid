import { describe, expect, layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Logger, Option, Queue, Ref, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { eq, sql } from 'drizzle-orm'
import { ServiceId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  ExecutorAppOwnership,
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorAuthorizationId,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorBinding,
  ExecutorTransportFailure,
  LegacyExecutorReferences,
  migrationPending,
  reconnectRequired,
} from './executor.ts'
import { migrateConnections, migrationLayer, removeConnection } from './migration.ts'
import { decodeRow, encodeReferences, listRecords } from './records.ts'
import { connections } from './tables.ts'
import { ConnectionStore } from './store.ts'
import { connectionTestLayer, fixture, hostedExecutorFixture, hostedPrefix } from './testing.ts'

const encodeLegacy = Schema.encodeEffect(LegacyExecutorReferences)
const storageError = Schema.TaggedStruct('StorageError', {})
const missingApp = Schema.TaggedStruct('AppNotFound', {})
const missingConnection = Schema.TaggedStruct('AccountConnectionNotFound', {})
const replies: ReadonlyArray<{ status: number; body: Schema.Json }> = [
  { status: 200, body: { apps: [], profiles: [] } },
  { status: 200, body: { apps: 'malformed', accounts: [], links: [] } },
  { status: 503, body: storageError.make({}) },
  { status: 404, body: missingApp.make({}) },
]
const savedRequests: ReadonlyArray<{ status: number; body: Schema.Json }> = [
  { status: 404, body: missingConnection.make({}) },
  { status: 404, body: missingApp.make({}) },
  {
    status: 200,
    body: {
      id: 'pending',
      target: { app: 'foreign', requirement: 'slot' },
      reconnectAccount: { id: 'external' },
      state: { status: 'completed', account: { id: 'external' } },
    },
  },
]

const original = ExecutorAppId.make('original')
const copied = ExecutorAppId.make('copied')
const account = ExecutorAccountId.make('selected')
const legacy = LegacyExecutorReferences.cases.Authorized.make({
  service: ServiceId.make('legacy'),
  owner: ExecutorOwnerId.make('owner'),
  app: original,
  account,
  profile: 'old-selection',
  appOwnership: 'Shared',
})
const pending = LegacyExecutorReferences.cases.EnteringKey.make({
  service: legacy.service,
  owner: legacy.owner,
  app: original,
  profile: 'pending-selection',
  appOwnership: 'Shared',
  authorization: ExecutorAuthorizationId.make('pending'),
  method: 'key',
  label: 'Pending',
})

/** Each case uses the existing Person cleanup and the file's disposable PostgreSQL clone. */
const seed = Effect.fn('Reconciliation.Test.seed')(function* (references: Schema.Json) {
  const { ownerActor } = yield* fixture()
  const database = yield* Database
  const id = crypto.randomUUID()
  yield* database.run(
    database.insert(connections).values({
      id,
      service: legacy.service,
      serviceName: 'Legacy',
      personId: ownerActor.person.id,
      status: 'ready',
      references,
      createdAt: 0,
      updatedAt: 0,
    }),
  )
  const read = database.run(database.select().from(connections).where(eq(connections.id, id))).pipe(
    Effect.map((rows) => {
      const row = rows[0]
      if (row === undefined) expect.fail('Expected stored Connection')
      return row
    }),
  )
  return { ownerActor, database, id, read }
})

/** A pending reconnect retains its credential even if the app and its request disappear. */
function pendingRetirementReplies() {
  return new Map<string, { status: number; body: Schema.Json }>([
    [
      `GET ${hostedPrefix}/inventory`,
      {
        status: 200,
        body: {
          apps: [
            {
              id: original,
              name: 'Dedicated',
              activeVersion: 'version',
              copiedFrom: null,
            },
          ],
          accounts: [{ id: account }],
          links: [{ app: original, account }],
        },
      },
    ],
    [
      `GET ${hostedPrefix}/connections/pending`,
      {
        status: 200,
        body: {
          id: 'pending',
          target: { app: original, requirement: 'slot' },
          reconnectAccount: { id: account },
          state: { status: 'pending' },
        },
      },
    ],
    [
      `GET ${hostedPrefix}/apps/${original}/accounts/user`,
      { status: 200, body: [{ requirement: 'slot', account: { id: account } }] },
    ],
    [`GET ${hostedPrefix}/apps/${original}/accounts/app`, { status: 200, body: [] }],
    [
      `DELETE ${hostedPrefix}/apps/${original}/accounts/user/slot/${account}`,
      { status: 200, body: {} },
    ],
    [`DELETE ${hostedPrefix}/apps/${original}`, { status: 200, body: {} }],
    [`DELETE ${hostedPrefix}/accounts/${account}`, { status: 503, body: storageError.make({}) }],
  ])
}

describe.skipIf(!testDatabaseConfigured)('scheduled legacy reconciliation', () => {
  layer(connectionTestLayer)((test) => {
    for (const reply of replies) {
      test.effect(
        `leaves every row untouched on incompatible inventory ${JSON.stringify(reply)}`,
        () =>
          Effect.gen(function* () {
            const first = yield* seed(yield* encodeLegacy(legacy))
            const second = yield* seed(yield* encodeLegacy(pending))
            const remote = yield* hostedExecutorFixture()
            yield* Ref.set(remote.replies, new Map([[`GET ${hostedPrefix}/inventory`, reply]]))
            // Each pass owns its Executor. Its unrelated catalog writer must be released before
            // the migration clock jumps, rather than replaying 48 hours of real HTTP refreshes.
            const reconcile = Effect.fn('Reconciliation.Test.pass')(function* () {
              const context = yield* Layer.build(remote.configured)
              return yield* migrateConnections().pipe(Effect.provide(context))
            }, Effect.scoped)
            const before = [yield* first.read, yield* second.read]
            yield* Ref.set(remote.requests, [])
            expect(yield* reconcile()).toBe(true)
            expect([yield* first.read, yield* second.read]).toEqual(before)
            expect(
              Option.getOrThrow(Option.fromUndefinedOr((yield* listRecords(first.ownerActor))[0]))
                .references._tag,
            ).toBe('MigrationPending')
            expect(
              (yield* Ref.get(remote.requests))
                .map((request) => request.path)
                .filter((path) => path !== `GET ${hostedPrefix}/catalog`),
            ).toEqual([`GET ${hostedPrefix}/inventory`])
            yield* TestClock.adjust('48 hours')
            expect(yield* reconcile()).toBe(true)
            expect([yield* first.read, yield* second.read]).toEqual(before)
            expect(
              (yield* Ref.get(remote.requests))
                .map((request) => request.path)
                .filter((path) => path !== `GET ${hostedPrefix}/catalog`),
            ).toEqual([`GET ${hostedPrefix}/inventory`, `GET ${hostedPrefix}/inventory`])
          }).pipe(Effect.scoped),
      )
    }

    test.effect('counter-only progress preserves a removal already preparing its retirement', () =>
      Effect.gen(function* () {
        const state = ExecutorReferences.cases.MigrationPending.make({
          ...migrationPending(legacy, 'CopyPending'),
          compatibleAttempts: 7,
        })
        const seeded = yield* seed(yield* encodeReferences(state))
        const before = yield* seeded.read
        const executor = yield* Executor
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delayed = Executor.of({
          ...executor,
          prepareRetirement: (resources) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(resources),
            ),
          reconcile: () => Effect.succeed(migrationPending(legacy, 'CopyPending')),
        })
        const removing = yield* removeConnection(yield* decodeRow(before)).pipe(
          Effect.provideService(Executor, delayed),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        const progressed = yield* migrateConnections().pipe(
          Effect.provideService(Executor, delayed),
          Effect.andThen(seeded.read),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        )
        expect(progressed).toEqual({
          ...before,
          references: yield* encodeReferences(
            ExecutorReferences.cases.MigrationPending.make({
              ...state,
              compatibleAttempts: 8,
            }),
          ),
        })
        yield* Fiber.join(removing)
        expect(yield* listRecords(seeded.ownerActor)).toEqual([])
      }).pipe(Effect.scoped),
    )

    test.effect('expires an exhausted stored budget even after a large compatible count', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.MigrationPending.make({
              ...migrationPending(legacy, 'CopyPending'),
              compatibleAttempts: 2 ** 31,
            }),
          ),
        )
        const executor = yield* Executor
        const retrying = Executor.of({
          ...executor,
          reconcile: () => Effect.succeed(migrationPending(legacy, 'CopyPending')),
        })
        expect(yield* migrateConnections().pipe(Effect.provideService(Executor, retrying))).toBe(
          false,
        )
        const expired = yield* decodeRow(yield* seeded.read)
        if (!ExecutorReferences.guards.ReconnectRequired(expired.references))
          expect.fail('Exhausted compatible budget must expire')
        expect(expired.references.reason).toBe('MigrationTargetMissing')
      }),
    )

    test.effect('a stale compatible pass cannot replace newer counter progress', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.MigrationPending.make({
              ...migrationPending(legacy, 'CopyPending'),
              compatibleAttempts: 7,
            }),
          ),
        )
        const executor = yield* Executor
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const outcome = migrationPending(legacy, 'CopyPending')
        const immediate = Executor.of({ ...executor, reconcile: () => Effect.succeed(outcome) })
        const delayed = Executor.of({
          ...executor,
          reconcile: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(outcome),
            ),
        })
        const running = yield* migrateConnections().pipe(
          Effect.provideService(Executor, delayed),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        yield* migrateConnections().pipe(Effect.provideService(Executor, immediate))
        yield* migrateConnections().pipe(Effect.provideService(Executor, immediate))
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(running)).toBe(true)
        const current = yield* decodeRow(yield* seeded.read)
        if (!ExecutorReferences.guards.MigrationPending(current.references))
          expect.fail('Unfinished migration must remain pending')
        expect(current.references.compatibleAttempts).toBe(9)
        expect(current.updatedAt).toBe(0)
      }).pipe(Effect.scoped),
    )

    test.effect(
      'pending Dedicated removal remembers the account after final revocation fails',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(
            yield* encodeReferences(
              ExecutorReferences.cases.EnteringKey.make({
                service: legacy.service,
                owner: legacy.owner,
                app: original,
                appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
                binding: ExecutorBinding.cases.Account.make({ requirement: 'slot', scope: 'user' }),
                authorization: pending.authorization,
                method: 'key',
                label: 'Pending',
              }),
            ),
          )
          yield* seeded.database.run(
            seeded.database
              .update(connections)
              .set({ executorApp: original })
              .where(eq(connections.id, seeded.id)),
          )
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(remote.replies, pendingRetirementReplies())
          yield* Ref.set(remote.intercept, (request) =>
            Ref.update(remote.replies, (replies) => {
              const next = new Map(replies)
              if (
                request.path ===
                `DELETE ${hostedPrefix}/apps/${original}/accounts/user/slot/${account}`
              )
                next.set(`GET ${hostedPrefix}/apps/${original}/accounts/user`, {
                  status: 200,
                  body: [],
                })
              if (request.path === `DELETE ${hostedPrefix}/apps/${original}`) {
                next.set(`GET ${hostedPrefix}/inventory`, {
                  status: 200,
                  body: {
                    apps: [],
                    accounts: [{ id: account }],
                    links: [],
                  },
                })
                next.set(`GET ${hostedPrefix}/connections/pending`, {
                  status: 404,
                  body: missingApp.make({}),
                })
              }
              return next
            }),
          )
          const context = yield* Layer.build(remote.configured)
          const failure = yield* removeConnection(yield* decodeRow(yield* seeded.read)).pipe(
            Effect.provide(context),
            Effect.flip,
          )
          expect(failure._tag).toBe('ServiceUnavailable')
          const retained = yield* decodeRow(yield* seeded.read)
          if (!ExecutorReferences.guards.ReconnectRequired(retained.references))
            expect.fail('Failed cleanup must retain its resolved account')
          expect(retained.references.retired.account).toEqual(Option.some(account))
          yield* Ref.update(remote.replies, (replies) =>
            new Map(replies).set(`DELETE ${hostedPrefix}/accounts/${account}`, {
              status: 200,
              body: {},
            }),
          )
          yield* removeConnection(retained).pipe(Effect.provide(context))
          expect(yield* listRecords(seeded.ownerActor)).toEqual([])
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([
            `DELETE ${hostedPrefix}/apps/${original}/accounts/user/slot/${account}`,
            `DELETE ${hostedPrefix}/apps/${original}`,
            `DELETE ${hostedPrefix}/accounts/${account}`,
            `DELETE ${hostedPrefix}/accounts/${account}`,
          ])
        }).pipe(Effect.scoped),
    )

    test.effect('counts compatible attempts without aging rows through a later global outage', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.MigrationPending.make({
              ...migrationPending(legacy, 'CopyPending'),
              compatibleAttempts: 1437,
            }),
          ),
        )
        const executor = yield* Executor
        const available = yield* Ref.make(true)
        const retrying = Executor.of({
          ...executor,
          inventory: Effect.flatMap(Ref.get(available), (ready) =>
            ready
              ? executor.inventory
              : ExecutorTransportFailure.make({ service: 'connections', tool: null }),
          ),
          reconcile: () => Effect.succeed(migrationPending(legacy, 'CopyPending')),
        })
        const pass = migrateConnections().pipe(Effect.provideService(Executor, retrying))
        expect(yield* pass).toBe(true)
        const first = yield* seeded.read
        yield* Ref.set(available, false)
        yield* TestClock.adjust('48 hours')
        expect(yield* pass).toBe(true)
        expect(yield* seeded.read).toEqual(first)
        yield* Ref.set(available, true)
        expect(yield* pass).toBe(true)
        const recovered = yield* decodeRow(yield* seeded.read)
        if (!ExecutorReferences.guards.MigrationPending(recovered.references))
          expect.fail('Recovery must not consume outage time')
        expect(recovered.references.compatibleAttempts).toBe(1439)
        expect(yield* pass).toBe(false)
        const final = yield* decodeRow(yield* seeded.read)
        if (!ExecutorReferences.guards.ReconnectRequired(final.references))
          expect.fail('Compatible budget must finish')
        expect(final.references.reason).toBe('MigrationTargetMissing')
      }),
    )

    test.effect(
      'forks at boot, keeps reads independent and interrupts stalled HTTP on scope close',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(yield* encodeLegacy(legacy))
          const executor = yield* Executor
          const entered = yield* Deferred.make<void>()
          const interrupted = yield* Deferred.make<void>()
          const stalled = Executor.of({
            ...executor,
            inventory: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
          })
          yield* Effect.gen(function* () {
            yield* Layer.build(migrationLayer).pipe(Effect.provideService(Executor, stalled))
            yield* Deferred.await(entered)
            const store = yield* ConnectionStore
            const listed = yield* store.records(seeded.ownerActor)
            expect(listed).toHaveLength(1)
            expect((yield* store.list(seeded.ownerActor)).connections).toHaveLength(1)
            expect(Option.getOrThrow(Option.fromUndefinedOr(listed[0])).references._tag).toBe(
              'MigrationPending',
            )
            expect((yield* seeded.read).updatedAt).toBe(0)
          }).pipe(Effect.scoped)
          expect(yield* Deferred.isDone(interrupted)).toBe(true)
        }),
    )

    test.effect(
      'backs off retryable probes in its scope and stops once only invalid rows remain',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(yield* encodeLegacy(legacy))
          const executor = yield* Executor
          const probes = yield* Queue.unbounded<void>()
          const recovering = Executor.of({
            ...executor,
            inventory: Queue.offer(probes, undefined).pipe(
              Effect.andThen(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
            ),
            reconcile: () => Effect.succeed(migrationPending(legacy, 'NotReady')),
          })
          yield* Layer.build(migrationLayer).pipe(Effect.provideService(Executor, recovering))
          yield* Queue.take(probes)
          yield* TestClock.adjust('5 seconds')
          yield* Queue.take(probes)
          // Invalid persisted data is logged and excluded; it cannot keep this upgrade alive.
          yield* seeded.database.run(
            seeded.database
              .update(connections)
              .set({ references: { profile: 'invalid' } })
              .where(eq(connections.id, seeded.id)),
          )
          expect(yield* migrateConnections()).toBe(false)
          yield* TestClock.adjust('2 minutes')
          expect(yield* Queue.size(probes)).toBe(0)
        }).pipe(Effect.scoped),
    )

    test.effect(
      'removes a migrated shared selection without deleting the app or another Person account',
      () =>
        Effect.gen(function* () {
          const a = yield* seed(yield* encodeLegacy(legacy))
          const b = yield* seed(
            yield* encodeLegacy({ ...legacy, account: ExecutorAccountId.make('other-person') }),
          )
          expect(a.ownerActor.person.id).not.toBe(b.ownerActor.person.id)
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(
            remote.replies,
            new Map<string, { status: number; body: Schema.Json }>([
              [
                `GET ${hostedPrefix}/inventory`,
                {
                  status: 200,
                  body: {
                    apps: [
                      { id: original, name: 'Shared', activeVersion: 'version', copiedFrom: null },
                    ],
                    accounts: [{ id: account }, { id: 'other-person' }],
                    links: [
                      { app: original, account },
                      { app: original, account: 'other-person' },
                    ],
                  },
                },
              ],
              [
                `GET ${hostedPrefix}/apps/${original}`,
                {
                  status: 200,
                  body: {
                    id: original,
                    name: 'Shared',
                    requirements: {
                      accounts: {
                        service: {
                          scope: 'user',
                          cardinality: 'one',
                          provider: 'provider',
                          definition: {
                            auth: {
                              key: { type: 'secrets', fields: { properties: { token: {} } } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
              [
                `GET ${hostedPrefix}/apps/${original}/accounts/user`,
                { status: 200, body: [{ requirement: 'service', account: { id: account } }] },
              ],
              [
                `GET ${hostedPrefix}/apps/${original}/accounts/app`,
                { status: 200, body: [{ requirement: 'other', account: { id: 'other-person' } }] },
              ],
              [`DELETE ${hostedPrefix}/accounts/${account}`, { status: 200, body: {} }],
            ]),
          )
          const context = yield* Layer.build(remote.configured)
          yield* migrateConnections().pipe(Effect.provide(context))
          const ready = yield* decodeRow(yield* a.read)
          if (!ExecutorReferences.guards.Authorized(ready.references)) expect.fail('A must migrate')
          expect(ready.references.appOwnership._tag).toBe('Unproven')
          expect(ready.executorApp).toBe(original)
          const beforeB = yield* b.read
          yield* removeConnection(ready).pipe(Effect.provide(context))
          expect(yield* listRecords(a.ownerActor)).toEqual([])
          expect(yield* b.read).toEqual(beforeB)
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([
            `DELETE ${hostedPrefix}/apps/${original}/accounts/user/service/${account}`,
            `DELETE ${hostedPrefix}/accounts/${account}`,
          ])
        }).pipe(Effect.scoped),
    )

    test.effect(
      'ordinary removal refuses a failed app preflight before deleting any credential',
      () =>
        Effect.gen(function* () {
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(
            remote.replies,
            new Map<string, { status: number; body: Schema.Json }>([
              [
                `GET ${hostedPrefix}/inventory`,
                {
                  status: 200,
                  body: {
                    apps: [
                      {
                        id: original,
                        name: 'Dedicated',
                        activeVersion: 'version',
                        copiedFrom: null,
                      },
                    ],
                    accounts: [{ id: account }],
                    links: [{ app: original, account }],
                  },
                },
              ],
              [
                `GET ${hostedPrefix}/apps/${original}/accounts/user`,
                { status: 503, body: storageError.make({}) },
              ],
              [`GET ${hostedPrefix}/apps/${original}/accounts/app`, { status: 200, body: [] }],
            ]),
          )
          const context = yield* Layer.build(remote.configured)
          const references = ExecutorReferences.cases.Authorized.make({
            service: legacy.service,
            owner: legacy.owner,
            app: original,
            appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
            account,
            binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
          })
          yield* Effect.flatMap(Executor, (executor) => executor.remove(references)).pipe(
            Effect.provide(context),
            Effect.flip,
          )
          expect(
            (yield* Ref.get(remote.requests)).filter((request) =>
              request.path.startsWith('DELETE'),
            ),
          ).toEqual([])
        }).pipe(Effect.scoped),
    )

    test.effect('does not resurrect a row removed while its migration response was in flight', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(yield* encodeLegacy(legacy))
        const executor = yield* Executor
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delayed = Executor.of({
          ...executor,
          reconcile: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(
                ExecutorReferences.cases.Authorized.make({
                  service: legacy.service,
                  owner: legacy.owner,
                  app: copied,
                  appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
                  account,
                  binding: ExecutorBinding.cases.Account.make({
                    requirement: 'service',
                    scope: 'user',
                  }),
                }),
              ),
            ),
        })
        const running = yield* migrateConnections().pipe(
          Effect.provideService(Executor, delayed),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        yield* removeConnection(yield* decodeRow(yield* seeded.read))
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(running)).toBe(false)
        expect(yield* listRecords(seeded.ownerActor)).toEqual([])
      }).pipe(Effect.scoped),
    )

    test.effect('keeps snapshot claims when another row removes the app during a pass', () =>
      Effect.gen(function* () {
        const owned = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.Authorized.make({
              service: legacy.service,
              owner: legacy.owner,
              app: copied,
              appOwnership: ExecutorAppOwnership.cases.Copied.make({ original }),
              account,
              binding: ExecutorBinding.cases.Account.make({
                requirement: 'service',
                scope: 'user',
              }),
            }),
          ),
        )
        yield* owned.database.run(
          owned.database
            .update(connections)
            .set({ executorApp: copied })
            .where(eq(connections.id, owned.id)),
        )
        const pendingRow = yield* seed(yield* encodeLegacy(legacy))
        const executor = yield* Executor
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const authorized = yield* decodeRow(yield* owned.read)
        const delayed = Executor.of({
          ...executor,
          reconcile: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(authorized.references),
            ),
        })
        const running = yield* migrateConnections().pipe(
          Effect.provideService(Executor, delayed),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        yield* removeConnection(authorized)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(running)).toBe(false)
        const refused = yield* decodeRow(yield* pendingRow.read)
        if (!ExecutorReferences.guards.ReconnectRequired(refused.references))
          expect.fail('Deleted app must never be claimed')
        expect(refused.references.reason).toBe('SharedSelection')
        expect(refused.executorApp).toBeNull()
      }).pipe(Effect.scoped),
    )

    test.effect('logs a terminating worker defect with its cause', () =>
      Effect.gen(function* () {
        yield* seed(yield* encodeLegacy(legacy))
        const executor = yield* Executor
        const logged = yield* Deferred.make<void>()
        const lines: Array<string> = []
        const logger = Logger.make((entry) => {
          const line = Logger.formatSimple.log(entry)
          lines.push(line)
          if (line.includes('Integration migration worker stopped'))
            Deferred.doneUnsafe(logged, Effect.void)
        })
        const broken = Executor.of({
          ...executor,
          inventory: Effect.die('migration defect fixture'),
        })
        yield* Layer.build(migrationLayer.pipe(Layer.provide(Logger.layer([logger])))).pipe(
          Effect.provideService(Executor, broken),
        )
        yield* Deferred.await(logged)
        expect(lines.join('\n')).toContain('migration defect fixture')
      }).pipe(Effect.scoped),
    )

    test.effect('ordinary removal proceeds while another reclamation holds the global lock', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.Public.make({
              appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
              service: legacy.service,
              owner: legacy.owner,
              app: original,
              binding: ExecutorBinding.cases.Public.make({}),
            }),
          ),
        )
        yield* seeded.database.run(
          seeded.database
            .update(connections)
            .set({ executorApp: original })
            .where(eq(connections.id, seeded.id)),
        )
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* seeded.database
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended('vivid-executor-migration', 0))`,
              )
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* removeConnection(yield* decodeRow(yield* seeded.read)).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
        )
        expect(yield* listRecords(seeded.ownerActor)).toEqual([])
      }).pipe(Effect.scoped),
    )

    test.effect('reports a corrupt holder distinctly before revoking any resources', () =>
      Effect.gen(function* () {
        const retired = yield* seed(
          yield* encodeReferences(reconnectRequired(legacy, 'UnresolvedMigration', [])),
        )
        const corrupt = yield* seed({ malformed: true })
        const executor = yield* Executor
        const revoked = yield* Ref.make(false)
        const recording = Executor.of({
          ...executor,
          prepareRetirement: (resources) => Effect.succeed(resources),
          retire: () => Ref.set(revoked, true),
        })
        const failure = yield* removeConnection(yield* decodeRow(yield* retired.read)).pipe(
          Effect.provideService(Executor, recording),
          Effect.flip,
        )
        expect(failure._tag).toBe('ConnectionReclamationBlocked')
        expect(failure).toHaveProperty('recordId', corrupt.id)
        expect(yield* Ref.get(revoked)).toBe(false)
      }),
    )
  })
})

/** The remote has exact copy lineage but an unrelated credential Vivid has no authority over. */
function inventory() {
  return {
    apps: [
      { id: original, name: 'Original', activeVersion: 'version', copiedFrom: null },
      {
        id: copied,
        name: 'Copy',
        activeVersion: 'version',
        copiedFrom: { reference: `app:${original}` },
      },
    ],
    accounts: [{ id: account }, { id: 'external' }],
    links: [{ app: copied, account: 'external' }],
  }
}

describe.skipIf(!testDatabaseConfigured)('pending removal', () => {
  layer(connectionTestLayer)((test) => {
    for (const request of savedRequests) {
      test.effect(
        `removes CopyPending without claiming a missing or foreign request ${JSON.stringify(request)}`,
        () =>
          Effect.gen(function* () {
            const seeded = yield* seed(
              yield* encodeReferences(migrationPending(pending, 'CopyPending')),
            )
            const remote = yield* hostedExecutorFixture()
            yield* Ref.set(
              remote.replies,
              new Map<string, { status: number; body: Schema.Json }>([
                [`GET ${hostedPrefix}/inventory`, { status: 200, body: inventory() }],
                [`GET ${hostedPrefix}/connections/pending`, request],
                [`GET ${hostedPrefix}/apps/${original}/accounts/user`, { status: 200, body: [] }],
                [`GET ${hostedPrefix}/apps/${original}/accounts/app`, { status: 200, body: [] }],
              ]),
            )
            const context = yield* Layer.build(remote.configured)
            yield* removeConnection(yield* decodeRow(yield* seeded.read)).pipe(
              Effect.provide(context),
            )
            expect(yield* listRecords(seeded.ownerActor)).toEqual([])
            expect(
              (yield* Ref.get(remote.requests)).filter((value) => value.path.startsWith('DELETE')),
            ).toEqual([])
          }).pipe(Effect.scoped),
      )
    }

    test.effect(
      'retains externally occupied provenance copies and deletes only its exact account last',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(
            yield* encodeReferences(reconnectRequired(legacy, 'AmbiguousMigration', [copied])),
          )
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(
            remote.replies,
            new Map<string, { status: number; body: Schema.Json }>([
              [`GET ${hostedPrefix}/inventory`, { status: 200, body: inventory() }],
              [`GET ${hostedPrefix}/apps/${original}/accounts/user`, { status: 200, body: [] }],
              [`GET ${hostedPrefix}/apps/${original}/accounts/app`, { status: 200, body: [] }],
              [
                `GET ${hostedPrefix}/apps/${copied}/accounts/user`,
                {
                  status: 200,
                  body: [
                    { requirement: 'slot', account: { id: account } },
                    { requirement: 'external', account: { id: 'external' } },
                  ],
                },
              ],
              [`GET ${hostedPrefix}/apps/${copied}/accounts/app`, { status: 200, body: [] }],
              [`DELETE ${hostedPrefix}/accounts/${account}`, { status: 200, body: {} }],
            ]),
          )
          const context = yield* Layer.build(remote.configured)
          const path = `GET ${hostedPrefix}/apps/${copied}/accounts/user`
          const selected = Option.getOrThrow(
            Option.fromUndefinedOr((yield* Ref.get(remote.replies)).get(path)),
          )
          yield* Ref.update(remote.replies, (replies) =>
            new Map(replies).set(path, {
              status: 503,
              body: storageError.make({}),
            }),
          )
          const failure = yield* removeConnection(yield* decodeRow(yield* seeded.read)).pipe(
            Effect.provide(context),
            Effect.flip,
          )
          expect(failure._tag).toBe('ServiceUnavailable')
          expect(
            (yield* Ref.get(remote.requests)).filter((request) =>
              request.path.startsWith('DELETE'),
            ),
          ).toEqual([])
          yield* Ref.update(remote.replies, (replies) => new Map(replies).set(path, selected))
          yield* removeConnection(yield* decodeRow(yield* seeded.read)).pipe(
            Effect.provide(context),
          )
          expect(yield* listRecords(seeded.ownerActor)).toEqual([])
          const requests = (yield* Ref.get(remote.requests))
            .map((request) => request.path)
            .filter((path) => path !== `GET ${hostedPrefix}/catalog`)
          expect(requests.filter((path) => path.startsWith('DELETE'))).toEqual([
            `DELETE ${hostedPrefix}/apps/${copied}/accounts/user/slot/${account}`,
            `DELETE ${hostedPrefix}/accounts/${account}`,
          ])
          expect(requests.at(-1)).toBe(`DELETE ${hostedPrefix}/accounts/${account}`)
        }).pipe(Effect.scoped),
    )
  })
})
