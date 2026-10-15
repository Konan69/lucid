import { describe, expect, layer } from '@effect/vitest'
import { Deferred, Effect, Layer, Option, Queue, Ref, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { eq, sql } from 'drizzle-orm'
import { ServiceId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
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
            const context = yield* Layer.build(remote.configured)
            const before = [yield* first.read, yield* second.read]
            yield* Ref.set(remote.requests, [])
            expect(yield* migrateConnections().pipe(Effect.provide(context))).toBe(true)
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
            expect(yield* migrateConnections().pipe(Effect.provide(context))).toBe(true)
            expect([yield* first.read, yield* second.read]).toEqual(before)
            expect(
              (yield* Ref.get(remote.requests))
                .map((request) => request.path)
                .filter((path) => path !== `GET ${hostedPrefix}/catalog`),
            ).toEqual([`GET ${hostedPrefix}/inventory`, `GET ${hostedPrefix}/inventory`])
          }).pipe(Effect.scoped),
      )
    }

    test.effect(
      'does not rewrite unchanged retries and expires a missing copy after 24 hours',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(yield* encodeLegacy(legacy))
          const executor = yield* Executor
          const probes = yield* Ref.make(0)
          const retrying = Executor.of({
            ...executor,
            inventory: executor.inventory.pipe(Effect.tap(() => Ref.update(probes, (n) => n + 1))),
            reconcile: () => Effect.succeed(migrationPending(legacy, 'CopyPending')),
          })
          const pass = migrateConnections().pipe(Effect.provideService(Executor, retrying))
          expect(yield* pass).toBe(true)
          const first = yield* seeded.read
          yield* TestClock.adjust('1 hour')
          expect(yield* pass).toBe(true)
          expect(yield* seeded.read).toEqual(first)
          yield* TestClock.adjust('23 hours')
          expect(yield* pass).toBe(false)
          const final = yield* decodeRow(yield* seeded.read)
          if (!ExecutorReferences.guards.ReconnectRequired(final.references))
            expect.fail('Missing copy must reach a permanent outcome')
          expect(final.references.reason).toBe('MigrationTargetMissing')
          expect(final.updatedAt).toBeGreaterThan(first.updatedAt)
          expect(yield* Ref.get(probes)).toBe(3)
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

    test.effect('ordinary removal proceeds while another reclamation holds the global lock', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.Public.make({
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
