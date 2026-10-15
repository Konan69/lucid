import { describe, expect, it, layer } from '@effect/vitest'
import { Effect, Layer, Ref, Schema, Clock } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  Executor,
  ExecutorBinding,
  executorReconnectMessage,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorReferences,
  LegacyExecutorReferences,
} from './executor.ts'
import { connectionTestLayer, fixture, hostedExecutorFixture, hostedPrefix } from './testing.ts'

import { testDatabaseConfigured } from '../database/testdb.ts'
import { Database } from '../database/client.ts'
import { connections } from './tables.ts'
import { decodeRow } from './records.ts'

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
                { id: original, name: 'Same name', copiedFrom: null },
                { id: copied, name: 'Same name', copiedFrom: { reference: `app:${original}` } },
                { id: 'unrelated', name: 'Same name', copiedFrom: { reference: 'app:another' } },
              ],
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
              apps: [{ id: original, name: 'A tempting name', copiedFrom: null }],
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
          const raw = yield* database.run(
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
          const rows = yield* Effect.forEach(raw, decodeRow).pipe(
            Effect.provideService(Executor, executor),
          )
          const first = rows[0]
          const second = rows[1]
          if (first === undefined || second === undefined)
            expect.fail('Both legacy rows must be read')
          expect(first.executorApp).toBe(original)
          expect(second.executorApp).toBeNull()
          expect(ExecutorReferences.guards.ReconnectRequired(second.references)).toBe(true)
          expect(second.status).toBe('failed')
          expect(second.reason).toBe(executorReconnectMessage)
        }).pipe(Effect.scoped),
    )
  })
})
