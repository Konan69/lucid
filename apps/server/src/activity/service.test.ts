import { ActivityPush } from './apns.ts'
import { PushTargetGone, PushUncertain } from '../push/receipts.ts'
import { runs } from '../threads/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { ActivityRegistration, RunId } from '@vivid/contracts'
import { Clock, ConfigProvider, Deferred, Effect, Fiber, Layer, Ref, Result } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { fixture } from '../push/testing.ts'
import { Activities, activitiesLayer, makeActivities } from './service.ts'
import { activityTargets } from './tables.ts'

const signing = NodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const signingConfig = ConfigProvider.fromUnknown({
  VIVID_APNS_PRIVATE_KEY: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  VIVID_APNS_TEAM_ID: 'test-team',
  VIVID_APNS_KEY_ID: 'test-key',
  VIVID_APNS_BUNDLE_ID: 'work.vivid.test',
  VIVID_APNS_ENVIRONMENT: 'sandbox',
})
const testing = activitiesLayer.pipe(
  Layer.provide(ConfigProvider.layer(signingConfig)),
  Layer.provideMerge(testDatabaseLayer),
)

/** PostgreSQL proves that token rotation preserves ownership and session revocation removes delivery authority. */
describe.skipIf(!testDatabaseConfigured)('ActivityKit registration', () => {
  layer(testing)((it) => {
    it.effect('a stale APNs refusal cannot retire a newer registered token', () =>
      Effect.gen(function* () {
        const owner = yield* fixture()
        const sent = yield* Deferred.make<void>()
        const refused = yield* Deferred.make<void>()
        const oldToken = 'b'.repeat(64)
        const newToken = 'c'.repeat(64)
        const staleReply = Deferred.succeed(sent, undefined).pipe(
          Effect.andThen(Deferred.await(refused)),
          Effect.andThen(Effect.fail(new PushTargetGone({}))),
        )
        const activities = yield* makeActivities().pipe(
          Effect.provideService(
            ActivityPush,
            ActivityPush.of({
              send: (_authority, token) => (token === oldToken ? staleReply : Effect.void),
            }),
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, signingConfig),
        )
        const now = yield* Clock.currentTimeMillis
        yield* owner.database.run(
          owner.database.insert(runs).values({
            id: RunId.make(NodeCrypto.randomUUID()),
            threadId: owner.threadId,
            personId: owner.person.id,
            turn: 1,
            origin: StoredRunOrigin.cases.Message.make({}),
            state: 'working',
            startedAt: now,
          }),
        )
        const installation = NodeCrypto.randomUUID()
        yield* activities.register(
          owner.person.id,
          owner.sessionId,
          ActivityRegistration.cases.Start.make({ installation, token: 'a'.repeat(64) }),
        )
        const pending = yield* activities
          .register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Update.make({ installation, token: oldToken }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(sent)
        yield* activities.register(
          owner.person.id,
          owner.sessionId,
          ActivityRegistration.cases.Update.make({ installation, token: newToken }),
        )
        yield* Deferred.succeed(refused, undefined)
        yield* Fiber.join(pending)
        const rows = yield* owner.database.run(
          owner.database
            .select()
            .from(activityTargets)
            .where(eq(activityTargets.installation, installation)),
        )
        expect(rows[0]).toMatchObject({ updateToken: newToken })
      }),
    )

    it.effect(
      'an uncertain start is not repeated for the same Run and does not disable the next Run',
      () =>
        Effect.gen(function* () {
          const owner = yield* fixture()
          const calls = yield* Ref.make(0)
          const activities = yield* makeActivities().pipe(
            Effect.provideService(
              ActivityPush,
              ActivityPush.of({
                send: () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Effect.fail(new PushUncertain({}))),
                  ),
              }),
            ),
            Effect.provideService(ConfigProvider.ConfigProvider, signingConfig),
          )
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Start.make({
              installation: NodeCrypto.randomUUID(),
              token: 'd'.repeat(64),
            }),
          )
          const first = RunId.make(NodeCrypto.randomUUID())
          const now = yield* Clock.currentTimeMillis
          yield* owner.database.run(
            owner.database.insert(runs).values({
              id: first,
              threadId: owner.threadId,
              personId: owner.person.id,
              turn: 1,
              origin: StoredRunOrigin.cases.Message.make({}),
              state: 'working',
              startedAt: now,
            }),
          )
          yield* activities.refresh(owner.person.id)
          yield* activities.refresh(owner.person.id)
          expect(yield* Ref.get(calls)).toBe(1)
          yield* owner.database.run(
            owner.database
              .update(runs)
              .set({ state: 'stopped', finishedAt: now })
              .where(eq(runs.id, first)),
          )
          yield* owner.database.run(
            owner.database.insert(runs).values({
              id: RunId.make(NodeCrypto.randomUUID()),
              threadId: owner.threadId,
              personId: owner.person.id,
              turn: 2,
              origin: StoredRunOrigin.cases.Message.make({}),
              state: 'working',
              startedAt: now + 1,
            }),
          )
          yield* activities.refresh(owner.person.id)
          expect(yield* Ref.get(calls)).toBe(2)
        }),
    )

    it.effect(
      'rotates push-to-start tokens only for the owner and cascades session revocation',
      () =>
        Effect.gen(function* () {
          const owner = yield* fixture()
          const other = yield* fixture()
          const activities = yield* Activities
          const installation = NodeCrypto.randomUUID()
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Start.make({ installation, token: 'a'.repeat(64) }),
          )
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Start.make({ installation, token: 'b'.repeat(64) }),
          )
          const refused = yield* activities
            .register(
              other.person.id,
              other.sessionId,
              ActivityRegistration.cases.Start.make({ installation, token: 'c'.repeat(64) }),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(refused) && refused.failure._tag).toBe('Conflict')
          const rows = yield* owner.database.run(
            owner.database
              .select()
              .from(activityTargets)
              .where(eq(activityTargets.installation, installation)),
          )
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            startToken: 'b'.repeat(64),
            updateToken: null,
          })
          yield* owner.database.run(
            owner.database.delete(sessionTable).where(eq(sessionTable.id, owner.sessionId)),
          )
          expect(
            yield* owner.database.run(
              owner.database
                .select()
                .from(activityTargets)
                .where(eq(activityTargets.installation, installation)),
            ),
          ).toEqual([])
        }),
    )
  })
})
