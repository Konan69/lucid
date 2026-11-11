import { ActivityPush } from './apns.ts'
import { PushTargetGone } from '../push/receipts.ts'
import { runs } from '../threads/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { ActivityRegistration, RunId, type ActivitySnapshot } from '@vivid/contracts'
import { Clock, ConfigProvider, Deferred, Effect, Fiber, Option, Ref, Result } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { fixture } from '../push/testing.ts'
import { makeActivities } from './service.ts'
import { activityTargets } from './tables.ts'

const signing = NodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const signingConfig = ConfigProvider.fromUnknown({
  VIVID_APNS_PRIVATE_KEY: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  VIVID_APNS_TEAM_ID: 'test-team',
  VIVID_APNS_KEY_ID: 'test-key',
  VIVID_APNS_BUNDLE_ID: 'work.vivid.test',
  VIVID_APNS_ENVIRONMENT: 'sandbox',
})
/** Activities with APNs replaced at its network boundary; every test owns what it hears. */
const activitiesWith = (send: ActivityPush['Service']['send']) =>
  makeActivities().pipe(
    Effect.provideService(ActivityPush, ActivityPush.of({ send })),
    Effect.provideService(ConfigProvider.ConfigProvider, signingConfig),
  )

/** One working Run in the fixture's Thread. */
const working = (owner: Effect.Success<ReturnType<typeof fixture>>, turn: number, at: number) =>
  Effect.gen(function* () {
    const id = RunId.make(NodeCrypto.randomUUID())
    yield* owner.database.run(
      owner.database.insert(runs).values({
        id,
        threadId: owner.threadId,
        personId: owner.person.id,
        turn,
        origin: StoredRunOrigin.cases.Message.make({}),
        state: 'working',
        startedAt: at,
      }),
    )
    return id
  })

/** PostgreSQL proves the card's lifecycle: one card, updated while work lasts, ended once. */
describe.skipIf(!testDatabaseConfigured)('Live Activity delivery', () => {
  layer(testDatabaseLayer)((it) => {
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
        const activities = yield* activitiesWith((_authority, token) =>
          token === oldToken ? staleReply : Effect.void,
        )
        yield* working(owner, 1, yield* Clock.currentTimeMillis)
        const installation = NodeCrypto.randomUUID()
        const pending = yield* activities
          .register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.make({ installation, token: oldToken }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(sent)
        yield* activities.register(
          owner.person.id,
          owner.sessionId,
          ActivityRegistration.make({ installation, token: newToken }),
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
      'updates the one card as its step moves, skips an unchanged push, ends it once with the outcome, and never starts one',
      () =>
        Effect.gen(function* () {
          const owner = yield* fixture()
          const pushes = yield* Ref.make<
            ReadonlyArray<{ event: string; token: string; snapshot: ActivitySnapshot }>
          >([])
          const activities = yield* activitiesWith((_authority, token, event, snapshot) =>
            Ref.update(pushes, (all) => [...all, { event, token, snapshot }]),
          )
          const now = yield* Clock.currentTimeMillis
          const first = yield* working(owner, 1, now)
          const token = 'd'.repeat(64)
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.make({ installation: NodeCrypto.randomUUID(), token }),
          )
          // The same content again is not pushed again.
          yield* activities.refresh(owner.person.id)
          yield* activities.note(
            owner.threadId,
            Option.some('Checking your calendar for next week'),
          )
          yield* activities.refresh(owner.person.id)
          const live = yield* Ref.get(pushes)
          expect(live).toMatchObject([
            {
              event: 'update',
              snapshot: {
                activeCount: 1,
                approval: null,
                rows: [{ thread: owner.threadId, phase: 'Working', line: null }],
              },
            },
            {
              event: 'update',
              snapshot: {
                rows: [{ phase: 'Working', line: 'Checking your calendar for next week' }],
              },
            },
          ])

          yield* owner.database.run(
            owner.database
              .update(runs)
              .set({ state: 'completed', finishedAt: now + 5 })
              .where(eq(runs.id, first)),
          )
          yield* activities.note(owner.threadId, Option.some('Booked Thursday 10:00 with Mirabel'))
          yield* activities.refresh(owner.person.id)
          yield* activities.refresh(owner.person.id)
          const ended = (yield* Ref.get(pushes)).slice(2)
          expect(ended).toMatchObject([
            {
              event: 'end',
              snapshot: {
                activeCount: 0,
                rows: [
                  {
                    thread: owner.threadId,
                    phase: 'Done',
                    line: 'Booked Thursday 10:00 with Mirabel',
                  },
                ],
              },
            },
          ])

          // The next Run's card is a new one the app starts; the server has nothing to address.
          yield* working(owner, 2, now + 10)
          yield* activities.refresh(owner.person.id)
          expect(yield* Ref.get(pushes)).toHaveLength(3)
        }),
    )

    it.effect('binds an installation to its owner and drops it with the session', () =>
      Effect.gen(function* () {
        const owner = yield* fixture()
        const other = yield* fixture()
        const activities = yield* activitiesWith(() => Effect.void)
        const installation = NodeCrypto.randomUUID()
        yield* activities.register(
          owner.person.id,
          owner.sessionId,
          ActivityRegistration.make({ installation, token: 'a'.repeat(64) }),
        )
        yield* activities.register(
          owner.person.id,
          owner.sessionId,
          ActivityRegistration.make({ installation, token: 'b'.repeat(64) }),
        )
        const refused = yield* activities
          .register(
            other.person.id,
            other.sessionId,
            ActivityRegistration.make({ installation, token: 'c'.repeat(64) }),
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
        expect(rows[0]).toMatchObject({ personId: owner.person.id, sessionId: owner.sessionId })
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
