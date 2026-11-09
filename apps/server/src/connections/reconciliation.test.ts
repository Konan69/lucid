import { describe, expect, it, layer } from '@effect/vitest'
import { Deferred, Effect, Layer, Option, Ref, Schema } from 'effect'
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
  installationCaller,
  executorReconnectMessage,
} from './executor.ts'
import { removeConnection } from './removal.ts'
import { decodeRow, encodeReferences, listRecords } from './records.ts'
import { connections } from './tables.ts'
import {
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
} from './testing.ts'

const storageError = Schema.TaggedStruct('StorageError', {})
const missingApp = Schema.TaggedStruct('AppNotFound', {})
const missingConnection = Schema.TaggedStruct('AccountConnectionNotFound', {})
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
const service = ServiceId.make('service')
const owner = ExecutorOwnerId.make('owner')
const reconnect = ExecutorReferences.cases.ReconnectRequired.make({
  service,
  owner,
  reason: 'AmbiguousMigration',
  retired: {
    original,
    ownership: 'Unproven',
    account: Option.some(account),
    copies: [copied],
    authorization: Option.none(),
  },
})
const pending = ExecutorReferences.cases.ReconnectRequired.make({
  service,
  owner,
  reason: 'UnresolvedMigration',
  retired: {
    original,
    ownership: 'Unproven',
    account: Option.none(),
    copies: [],
    authorization: Option.some(ExecutorAuthorizationId.make('pending')),
  },
})

/** Each case uses the existing Person cleanup and the file's disposable PostgreSQL clone. */
const seed = Effect.fn('Reconciliation.Test.seed')(function* (references: Schema.Json) {
  const { ownerActor } = yield* fixture()
  const database = yield* Database
  const id = crypto.randomUUID()
  yield* database.run(
    database.insert(connections).values({
      id,
      service,
      serviceName: 'Service',
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

describe.skipIf(!testDatabaseConfigured)('resource removal', () => {
  layer(connectionTestLayer)((test) => {
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
            service,
            owner,
            app: original,
            appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
            account,
            binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
          })
          yield* Effect.flatMap(Executor, (executor) =>
            executor.as(installationCaller).remove(references),
          ).pipe(Effect.provide(context), Effect.flip)
          expect(
            (yield* Ref.get(remote.requests)).filter((request) =>
              request.path.startsWith('DELETE'),
            ),
          ).toEqual([])
        }).pipe(Effect.scoped),
    )

    test.effect(
      'pending Dedicated removal remembers the account after final revocation fails',
      () =>
        Effect.gen(function* () {
          const seeded = yield* seed(
            yield* encodeReferences(
              ExecutorReferences.cases.EnteringKey.make({
                service: service,
                owner: owner,
                app: original,
                appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
                binding: ExecutorBinding.cases.Account.make({ requirement: 'slot', scope: 'user' }),
                authorization: ExecutorAuthorizationId.make('pending'),
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

    test.effect('rejects an active app claim that disagrees with its references', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const database = yield* Database
        const references = ExecutorReferences.cases.Public.make({
          appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
          service: service,
          owner: owner,
          app: original,
          binding: ExecutorBinding.cases.Public.make({}),
        })
        const [raw] = yield* database.run(
          database
            .insert(connections)
            .values({
              id: crypto.randomUUID(),
              service: service,
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
            appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
            service: service,
            owner: ExecutorOwnerId.make('person-a'),
            app: original,
            binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
            account: other,
          })
          const retired = ExecutorReferences.cases.ReconnectRequired.make({
            ...reconnect,
            retired: { ...reconnect.retired, copies: [] },
          })
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
                service: service,
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
    test.effect('ordinary removal proceeds while another reclamation holds the global lock', () =>
      Effect.gen(function* () {
        const seeded = yield* seed(
          yield* encodeReferences(
            ExecutorReferences.cases.Public.make({
              appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
              service,
              owner,
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
        const retired = yield* seed(yield* encodeReferences(reconnect))
        const corrupt = yield* seed({ malformed: true })
        const executor = yield* Executor
        const revoked = yield* Ref.make(false)
        const recording = Executor.of({
          ...executor,
          as: (caller) => ({
            ...executor.as(caller),
            prepareRetirement: (resources) => Effect.succeed(resources),
            retire: () => Ref.set(revoked, true),
          }),
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
        `removes a pending reconnect without claiming a missing or foreign request ${JSON.stringify(request)}`,
        () =>
          Effect.gen(function* () {
            const seeded = yield* seed(yield* encodeReferences(pending))
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
          const seeded = yield* seed(yield* encodeReferences(reconnect))
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

const accountMissing = Schema.TaggedStruct('AccountNotFound', {})

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
    [`DELETE ${hostedPrefix}/accounts/${account}`, { status: 503, body: storageError.make({}) }],
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
      const refused = reconnect
      yield* Effect.flatMap(Executor, (executor) =>
        executor.as(installationCaller).retire({
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

/** App retention and credential retention are independent: another row may hold a different account. */
it.effect(
  'revokes an unclaimed credential while preserving a copy retained by another Connection',
  () =>
    Effect.gen(function* () {
      const remote = yield* hostedExecutorFixture()
      const other = ExecutorAccountId.make('other-account')
      yield* Ref.set(
        remote.replies,
        retirementReplies(other).set(`DELETE ${hostedPrefix}/accounts/${account}`, {
          status: 200,
          body: {},
        }),
      )
      const context = yield* Layer.build(remote.configured)
      const refused = reconnect
      yield* Effect.flatMap(Executor, (executor) =>
        executor.as(installationCaller).retire({
          resources: refused.retired,
          retainedApps: [original, copied],
          retainedAccounts: [other],
        }),
      ).pipe(Effect.provide(context))
      const deleted = (yield* Ref.get(remote.requests))
        .filter((request) => request.path.startsWith('DELETE'))
        .map((request) => request.path)
      expect(deleted).toEqual([
        `DELETE ${hostedPrefix}/apps/${copied}/accounts/user/service/${account}`,
        `DELETE ${hostedPrefix}/accounts/${account}`,
      ])
    }).pipe(Effect.scoped),
)
