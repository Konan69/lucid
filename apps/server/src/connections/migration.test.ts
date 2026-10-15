import { describe, expect, it, layer } from '@effect/vitest'
import { Effect, Layer, Ref, Schema, Clock, Option } from 'effect'
import { ServiceId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import {
  Executor,
  ExecutorBinding,
  executorReconnectMessage,
  ExecutorAccountId,
  ExecutorAuthorizationId,
  ExecutorResponseInvalid,
  ExecutorTransportFailure,
  reconnectRequired,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorReferences,
  LegacyExecutorReferences,
} from './executor.ts'
import {
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
} from './testing.ts'

import { testDatabaseConfigured } from '../database/testdb.ts'
import { Database } from '../database/client.ts'
import { connections } from './tables.ts'
import { decodeRow, listRecords, encodeReferences } from './records.ts'
import { migrateConnections, removeConnection } from './migration.ts'

const accountMissing = Schema.TaggedStruct('AccountNotFound', {})
const storageFailed = Schema.TaggedStruct('StorageError', {})

const encodeLegacy = Schema.encodeEffect(LegacyExecutorReferences)

const original = ExecutorAppId.make('original')
const copied = ExecutorAppId.make('copied')
const account = ExecutorAccountId.make('selected-account')
const legacy = LegacyExecutorReferences.cases.Authorized.make({
  service: ServiceId.make('legacy-service'),
  owner: ExecutorOwnerId.make('legacy-owner'),
  app: original,
  account,
  profile: 'removed-selection',
  appOwnership: 'Shared',
})
const requirement = {
  scope: 'user',
  cardinality: 'one',
  provider: 'provider',
  definition: { auth: { key: { type: 'secrets', fields: { properties: { token: {} } } } } },
}

/** API provenance and requirement links are the proof, even when unrelated apps have the same name. */
it.effect('uses exact migrated copy provenance and selected account, never an app name match', () =>
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
                { id: original, name: 'Same name', copiedFrom: null, activeVersion: 'version' },
                {
                  id: copied,
                  name: 'Same name',
                  copiedFrom: { reference: `app:${original}` },
                  activeVersion: 'version',
                },
                {
                  id: 'unrelated',
                  name: 'Same name',
                  copiedFrom: { reference: 'app:another' },
                  activeVersion: 'version',
                },
              ],
              accounts: [{ id: account }],
              links: [
                { app: copied, account },
                { app: 'unrelated', account },
              ],
            },
          },
        ],
        [
          `GET ${hostedPrefix}/apps/${copied}`,
          {
            status: 200,
            body: {
              id: copied,
              name: 'Same name',
              requirements: { accounts: { service: requirement } },
            },
          },
        ],
        [
          `GET ${hostedPrefix}/apps/${copied}/accounts/user`,
          { status: 200, body: [{ requirement: 'service', account: { id: account } }] },
        ],
      ]),
    )
    const context = yield* Layer.build(remote.configured)
    const references = yield* Effect.flatMap(Executor, (executor) =>
      executor.reconcile(legacy),
    ).pipe(Effect.provide(context))
    expect(references).toEqual(
      ExecutorReferences.cases.Authorized.make({
        service: legacy.service,
        owner: legacy.owner,
        app: copied,
        account,
        binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
      }),
    )
    expect(JSON.stringify(references)).not.toMatch(/profile|appOwnership/u)
    expect(
      (yield* Ref.get(remote.requests)).some((request) => request.path.includes('/apps/unrelated')),
    ).toBe(false)
  }).pipe(Effect.scoped),
)

/** No exact account-link match is reconnection, and an unresolved row grants no deletion authority. */
it.effect('requires reconnection when the exact legacy account cannot be mapped', () =>
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
                  name: 'A tempting name',
                  copiedFrom: null,
                  activeVersion: 'version',
                },
              ],
              accounts: [],
              links: [],
            },
          },
        ],
      ]),
    )
    const context = yield* Layer.build(remote.configured)
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const references = yield* executor.reconcile(legacy)
      expect(ExecutorReferences.guards.ReconnectRequired(references)).toBe(true)
      expect((yield* executor.tools(references).pipe(Effect.flip))._tag).toBe('ExecutorNotReady')
      yield* executor.remove(references)
    }).pipe(Effect.provide(context))
    expect(
      (yield* Ref.get(remote.requests)).some((request) => request.path.startsWith('DELETE')),
    ).toBe(false)
  }).pipe(Effect.scoped),
)

/** The real unique index arbitrates two legacy rows whose merged upstream selection is identical. */
describe.skipIf(!testDatabaseConfigured)('legacy app claims', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'keeps one app claim and turns the conflicting Connection into explicit reconnection',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const database = yield* Database
          const prior = yield* Executor
          const canonical = ExecutorReferences.cases.Authorized.make({
            service: legacy.service,
            app: original,
            owner: legacy.owner,
            account,
            binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
          })
          const executor = Executor.of({
            ...prior,
            reconcile: Effect.fn('Executor.Test.reconcileMergedSelection')(() =>
              Effect.succeed(canonical),
            ),
          })
          const references = yield* encodeLegacy(legacy)
          const now = yield* Clock.currentTimeMillis
          yield* database.run(
            database
              .insert(connections)
              .values(
                [crypto.randomUUID(), crypto.randomUUID()].map((id) => ({
                  id,
                  service: legacy.service,
                  serviceName: 'Legacy service',
                  personId: ownerActor.person.id,
                  references,
                  status: 'ready',
                  createdAt: now,
                  updatedAt: now,
                })),
              )
              .returning(),
          )
          yield* migrateConnections().pipe(Effect.provideService(Executor, executor))
          const migrated = yield* database.run(database.select().from(connections))
          const rows = yield* Effect.forEach(migrated, decodeRow)
          const first = rows.find((row) => ExecutorReferences.guards.Authorized(row.references))
          const second = rows.find((row) =>
            ExecutorReferences.guards.ReconnectRequired(row.references),
          )
          if (first === undefined || second === undefined)
            expect.fail('Both legacy rows must be read')
          expect(first.executorApp).toBe(original)
          expect(second.executorApp).toBeNull()
          expect(ExecutorReferences.guards.ReconnectRequired(second.references)).toBe(true)
          expect(second.status).toBe('failed')
          expect(second.reason).toBe(executorReconnectMessage)
          expect(second.updatedAt).toBeGreaterThan(now)
          if (!ExecutorReferences.guards.ReconnectRequired(second.references))
            expect.fail('Reconnect state required')
          expect(second.references.retired.account).toEqual(Option.some(account))
          yield* migrateConnections().pipe(Effect.provideService(Executor, executor))
          const again = yield* database.run(database.select().from(connections))
          expect(again.map((row) => row.updatedAt)).toEqual(migrated.map((row) => row.updatedAt))
        }).pipe(Effect.scoped),
    )
  })
})

const pendingB = LegacyExecutorReferences.cases.EnteringKey.make({
  service: legacy.service,
  owner: ExecutorOwnerId.make('person-b'),
  app: original,
  profile: 'person-b-pending',
  appOwnership: 'Shared',
  authorization: ExecutorAuthorizationId.make('pending-b'),
  method: 'key',
  label: 'B',
})

/** A's exact account remains linked while B's pending request targets the same shared app. */
function pendingSharedReplies() {
  return new Map<string, { status: number; body: Schema.Json }>([
    [
      `GET ${hostedPrefix}/inventory`,
      {
        status: 200,
        body: {
          apps: [{ id: original, name: 'Shared', activeVersion: 'version', copiedFrom: null }],
          accounts: [{ id: account }],
          links: [{ app: original, account }],
        },
      },
    ],
    [
      `GET ${hostedPrefix}/connections/pending-b`,
      {
        status: 200,
        body: {
          id: 'pending-b',
          reconnectAccount: null,
          target: { app: original, requirement: 'service' },
          state: { status: 'pending' },
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
          requirements: { accounts: { service: requirement } },
        },
      },
    ],
    [
      `GET ${hostedPrefix}/apps/${original}/accounts/user`,
      { status: 200, body: [{ requirement: 'service', account: { id: account } }] },
    ],
  ])
}

/** A pending request is not evidence that the app's currently linked account belongs to it. */
it.effect('refuses Person B pending on Person A ready shared app without changing A', () =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    yield* Ref.set(remote.replies, pendingSharedReplies())
    const context = yield* Layer.build(remote.configured)
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const b = yield* executor.reconcile(pendingB)
      if (!ExecutorReferences.guards.ReconnectRequired(b)) expect.fail('B must reconnect')
      expect(b.reason).toBe('SharedSelection')
      expect(b.retired.account).toEqual(Option.none())
      const a = yield* executor.reconcile(legacy)
      if (!ExecutorReferences.guards.Authorized(a)) expect.fail('A must keep its exact account')
      expect(a.account).toBe(account)
      expect(a.app).toBe(original)
    }).pipe(Effect.provide(context))
    expect(
      (yield* Ref.get(remote.requests)).some((request) => request.path.startsWith('DELETE')),
    ).toBe(false)
  }).pipe(Effect.scoped),
)

/** An undeployed copy and an account awaiting its copy plan can recover without reconnecting. */
it.effect('defers undeployed copies and pending copy plans', () =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    const context = yield* Layer.build(remote.configured)
    for (const linked of [false, true]) {
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
                    id: copied,
                    name: 'Copy',
                    activeVersion: null,
                    copiedFrom: { reference: `app:${original}` },
                  },
                ],
                accounts: [{ id: account }],
                links: linked ? [{ app: copied, account }] : [],
              },
            },
          ],
        ]),
      )
      const result = yield* Effect.flatMap(Executor, (executor) => executor.reconcile(legacy)).pipe(
        Effect.provide(context),
      )
      if (!ExecutorReferences.guards.MigrationPending(result))
        expect.fail('The selection must stay retryable')
      expect(result.reason).toBe(linked ? 'NotReady' : 'CopyPending')
      expect(result.legacy).toEqual(legacy)
    }
  }).pipe(Effect.scoped),
)

/** Icons are untrusted addresses; malformed and active schemes cannot reach client rendering. */
it.effect('keeps only HTTPS light or neutral catalog icons', () =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    const icons: Schema.Json[] = [
      { src: 'javascript:alert(1)' },
      { src: 'https://icons.example.test/dark.svg', theme: 'dark' },
      { src: 'http://icons.example.test/light.svg', theme: 'light' },
      { src: 'https://icons.example.test/light.svg', theme: 'light' },
    ]
    yield* Ref.set(remote.catalog, [
      {
        id: hostedService,
        package: '@test/service',
        name: 'Service',
        description: '',
        auth: [],
        icons,
      },
    ])
    const context = yield* Layer.build(remote.configured)
    const entries = yield* Effect.flatMap(Executor, (executor) => executor.catalog).pipe(
      Effect.provide(context),
    )
    const entry = entries.find((value) => value.id === hostedService)
    expect(Option.getOrThrow(Option.fromUndefinedOr(entry)).icon).toBe(
      'https://icons.example.test/light.svg',
    )
  }).pipe(Effect.scoped),
)

/** Persistence and cleanup claims are exercised on the real disposable PostgreSQL schema. */
describe.skipIf(!testDatabaseConfigured)('migration outcomes and reclamation', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'isolates refusals, retains retries and keeps decodeRow free of Executor calls',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const database = yield* Database
          const prior = yield* Executor
          const attempts = yield* Ref.make(0)
          const recovering = yield* Ref.make(false)
          const executor = Executor.of({
            ...prior,
            reconcile: Effect.fn('Executor.Test.migrationOutcome')(function* (value) {
              yield* Ref.update(attempts, (count) => count + 1)
              if (value.owner === 'bad')
                return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
              if (value.owner === 'retry' && !(yield* Ref.get(recovering)))
                return yield* ExecutorTransportFailure.make({ service: 'connections', tool: null })
              return ExecutorReferences.cases.Authorized.make({
                service: value.service,
                owner: value.owner,
                app: ExecutorAppId.make(`app-${value.owner}`),
                account,
                binding: ExecutorBinding.cases.Account.make({
                  requirement: 'service',
                  scope: 'user',
                }),
              })
            }),
          })
          for (const name of ['good', 'bad', 'retry']) {
            yield* database.run(
              database.insert(connections).values({
                id: crypto.randomUUID(),
                service: legacy.service,
                serviceName: name,
                personId: ownerActor.person.id,
                status: 'ready',
                createdAt: 0,
                updatedAt: 0,
                references: yield* encodeLegacy({ ...legacy, owner: ExecutorOwnerId.make(name) }),
              }),
            )
          }
          const untouched = yield* database.run(database.select().from(connections))
          const before = yield* Effect.forEach(untouched, decodeRow)
          expect(
            before.every((row) => ExecutorReferences.guards.MigrationPending(row.references)),
          ).toBe(true)
          expect(yield* Ref.get(attempts)).toBe(0)
          yield* migrateConnections().pipe(Effect.provideService(Executor, executor))
          const listed = yield* listRecords(ownerActor)
          expect(listed).toHaveLength(3)
          expect(
            Option.getOrThrow(
              Option.fromUndefinedOr(listed.find((row) => row.serviceName === 'good')),
            ).references._tag,
          ).toBe('Authorized')
          expect(
            Option.getOrThrow(
              Option.fromUndefinedOr(listed.find((row) => row.serviceName === 'bad')),
            ).references._tag,
          ).toBe('ReconnectRequired')
          expect(
            Option.getOrThrow(
              Option.fromUndefinedOr(listed.find((row) => row.serviceName === 'retry')),
            ).references._tag,
          ).toBe('MigrationPending')
          expect(yield* Ref.get(attempts)).toBe(3)
          yield* Ref.set(recovering, true)
          yield* migrateConnections().pipe(Effect.provideService(Executor, executor))
          expect(
            Option.getOrThrow(
              Option.fromUndefinedOr(
                (yield* listRecords(ownerActor)).find((row) => row.serviceName === 'retry'),
              ),
            ).references._tag,
          ).toBe('Authorized')
          expect(yield* Ref.get(attempts)).toBe(4)
        }),
    )

    test.effect('keeps A ready when B pending is migrated first and removed', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const database = yield* Database
        const remote = yield* hostedExecutorFixture()
        yield* Ref.set(remote.replies, pendingSharedReplies())
        const context = yield* Layer.build(remote.configured)
        const b = crypto.randomUUID()
        const a = crypto.randomUUID()
        yield* database.run(
          database.insert(connections).values([
            {
              id: b,
              service: legacy.service,
              serviceName: 'B',
              personId: memberActor.person.id,
              status: 'needs-authorization',
              references: yield* encodeLegacy(pendingB),
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: a,
              service: legacy.service,
              serviceName: 'A',
              personId: ownerActor.person.id,
              status: 'ready',
              references: yield* encodeLegacy(legacy),
              createdAt: 1,
              updatedAt: 1,
            },
          ]),
        )
        yield* migrateConnections().pipe(Effect.provide(context))
        const raw = yield* database.run(database.select().from(connections))
        const rows = yield* Effect.forEach(raw, decodeRow)
        const rowA = Option.getOrThrow(Option.fromUndefinedOr(rows.find((row) => row.id === a)))
        const rowB = Option.getOrThrow(Option.fromUndefinedOr(rows.find((row) => row.id === b)))
        expect(rowA.status).toBe('ready')
        expect(rowA.executorApp).toBe(original)
        expect(rowB.executorApp).toBeNull()
        if (!ExecutorReferences.guards.ReconnectRequired(rowB.references))
          expect.fail('B must reconnect')
        expect(rowB.references.reason).toBe('SharedSelection')
        yield* removeConnection(rowB).pipe(Effect.provide(context))
        expect(
          (yield* database.run(database.select().from(connections))).map((row) => row.id),
        ).toEqual([a])
        expect(
          (yield* Ref.get(remote.requests)).some((request) => request.path.startsWith('DELETE')),
        ).toBe(false)
      }).pipe(Effect.scoped),
    )

    test.effect('rejects an active app claim that disagrees with its references', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const database = yield* Database
        const references = ExecutorReferences.cases.Public.make({
          service: legacy.service,
          owner: legacy.owner,
          app: original,
          binding: ExecutorBinding.cases.Public.make({}),
        })
        const [raw] = yield* database.run(
          database
            .insert(connections)
            .values({
              id: crypto.randomUUID(),
              service: legacy.service,
              serviceName: 'Mismatch',
              personId: ownerActor.person.id,
              status: 'ready',
              createdAt: 0,
              updatedAt: 0,
              executorApp: copied,
              references: yield* encodeReferences(references),
            })
            .returning(),
        )
        if (raw === undefined) expect.fail('Stored row required')
        expect((yield* decodeRow(raw).pipe(Effect.flip))._tag).toBe('DatabaseFailure')
      }),
    )

    test.effect(
      'retains copy IDs across response loss and removes only unreferenced credentials and copies',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const database = yield* Database
          const remote = yield* hostedExecutorFixture()
          const other = ExecutorAccountId.make('person-a-account')
          const kept = ExecutorReferences.cases.Authorized.make({
            service: legacy.service,
            owner: ExecutorOwnerId.make('person-a'),
            app: original,
            binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
            account: other,
          })
          const retired = reconnectRequired(legacy, 'AmbiguousMigration', [])
          const values = [
            {
              id: crypto.randomUUID(),
              personId: ownerActor.person.id,
              executorApp: original,
              references: kept,
            },
            {
              id: crypto.randomUUID(),
              personId: memberActor.person.id,
              executorApp: null,
              references: retired,
            },
          ]
          for (const value of values)
            yield* database.run(
              database.insert(connections).values({
                ...value,
                service: legacy.service,
                serviceName: 'Cleanup',
                status: 'failed',
                reason: executorReconnectMessage,
                references: yield* encodeReferences(value.references),
                createdAt: 0,
                updatedAt: 0,
              }),
            )
          yield* Ref.set(remote.replies, retirementReplies(other))
          yield* Ref.set(remote.intercept, (request) =>
            request.path ===
            `DELETE ${hostedPrefix}/apps/${copied}/accounts/user/service/${account}`
              ? Ref.update(remote.replies, (replies) =>
                  new Map(replies).set(`GET ${hostedPrefix}/apps/${copied}/accounts/user`, {
                    status: 200,
                    body: [],
                  }),
                )
              : Effect.void,
          )
          const context = yield* Layer.build(remote.configured)
          const id = Option.getOrThrow(Option.fromUndefinedOr(values[1])).id
          if (id === undefined) expect.fail('Retired Connection required')
          const raw = (yield* database.run(
            database.select().from(connections).where(eq(connections.id, id)),
          ))[0]
          if (raw === undefined) expect.fail('Stored retired Connection required')
          const row = yield* decodeRow(raw)
          const failed = yield* removeConnection(row).pipe(Effect.provide(context), Effect.flip)
          expect(failed._tag).toBe('ServiceUnavailable')
          const retained = (yield* database.run(
            database.select().from(connections).where(eq(connections.id, id)),
          ))[0]
          if (retained === undefined) expect.fail('Response loss must retain the product row')
          const retry = yield* decodeRow(retained)
          if (!ExecutorReferences.guards.ReconnectRequired(retry.references))
            expect.fail('Retirement must remain resumable')
          expect(retry.references.retired.copies).toContain(copied)
          yield* Ref.update(remote.replies, (replies) =>
            new Map(replies).set(`DELETE ${hostedPrefix}/accounts/${account}`, {
              status: 404,
              body: accountMissing.make({}),
            }),
          )
          yield* removeConnection(retry).pipe(Effect.provide(context))
          const remaining = yield* database.run(database.select().from(connections))
          expect(remaining).toHaveLength(1)
          expect(Option.getOrThrow(Option.fromUndefinedOr(remaining[0])).executorApp).toBe(original)
          const deleted = (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path)
          expect(deleted).toContain(`DELETE ${hostedPrefix}/accounts/${account}`)
          expect(deleted).toContain(`DELETE ${hostedPrefix}/apps/${copied}`)
          expect(deleted).not.toContain(`DELETE ${hostedPrefix}/apps/${original}`)
          expect(deleted).not.toContain(`DELETE ${hostedPrefix}/accounts/${other}`)
        }).pipe(Effect.scoped),
    )
  })
})

/** The selected copy belongs to the retired account; the original still serves another Person. */
function retirementReplies(other: typeof ExecutorAccountId.Type) {
  return new Map<string, { status: number; body: Schema.Json }>([
    [
      `GET ${hostedPrefix}/inventory`,
      {
        status: 200,
        body: {
          apps: [
            { id: original, name: 'Shared', activeVersion: 'version', copiedFrom: null },
            {
              id: copied,
              name: 'Copy',
              activeVersion: 'version',
              copiedFrom: { reference: `app:${original}` },
            },
          ],
          accounts: [{ id: account }, { id: other }],
          links: [
            { app: original, account: other },
            { app: copied, account },
          ],
        },
      },
    ],
    [
      `GET ${hostedPrefix}/apps/${original}/accounts/user`,
      { status: 200, body: [{ requirement: 'service', account: { id: other } }] },
    ],
    [`GET ${hostedPrefix}/apps/${original}/accounts/app`, { status: 200, body: [] }],
    [
      `GET ${hostedPrefix}/apps/${copied}/accounts/user`,
      { status: 200, body: [{ requirement: 'service', account: { id: account } }] },
    ],
    [`GET ${hostedPrefix}/apps/${copied}/accounts/app`, { status: 200, body: [] }],
    [`DELETE ${hostedPrefix}/accounts/${account}`, { status: 503, body: storageFailed.make({}) }],
  ])
}

/** A Connection can own its copy while the exact credential is still referenced elsewhere. */
it.effect(
  'unlinks an unclaimed copy without revoking a credential retained by another Connection',
  () =>
    Effect.gen(function* () {
      const remote = yield* hostedExecutorFixture()
      yield* Ref.set(remote.replies, retirementReplies(account))
      yield* Ref.set(remote.intercept, (request) =>
        request.path === `DELETE ${hostedPrefix}/apps/${copied}/accounts/user/service/${account}`
          ? Ref.update(remote.replies, (replies) =>
              new Map(replies).set(`GET ${hostedPrefix}/apps/${copied}/accounts/user`, {
                status: 200,
                body: [],
              }),
            )
          : Effect.void,
      )
      const context = yield* Layer.build(remote.configured)
      const refused = reconnectRequired(legacy, 'AmbiguousMigration', [copied])
      yield* Effect.flatMap(Executor, (executor) =>
        executor.retire({
          resources: refused.retired,
          retainedApps: [original],
          retainedAccounts: [account],
        }),
      ).pipe(Effect.provide(context))
      const deleted = (yield* Ref.get(remote.requests))
        .filter((request) => request.path.startsWith('DELETE'))
        .map((request) => request.path)
      expect(deleted).toEqual([
        `DELETE ${hostedPrefix}/apps/${copied}/accounts/user/service/${account}`,
        `DELETE ${hostedPrefix}/apps/${copied}`,
      ])
    }).pipe(Effect.scoped),
)
