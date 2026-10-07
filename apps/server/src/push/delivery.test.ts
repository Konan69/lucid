import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Effect, Option, Ref, Result, Schema, Stream, Layer } from 'effect'
import { Clock } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  NotificationId,
  NotifyPersonOutcome,
  PushOutcome,
  RunId,
  PushPayload,
  PushDestination,
  SessionId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { sessionTable } from '../auth/tables.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { recordNotice } from '../notifications/notifier.ts'
import { notifications } from '../notifications/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { Presence } from '../threads/presence.ts'
import { automaticallyNotifies, RunStore, TurnReservation } from '../threads/runs.ts'
import { threads } from '../threads/tables.ts'
import { PushConfig } from './config.ts'
import { Push, pushLayer } from './delivery.ts'
import { pushHandlers } from './handlers.ts'
import { PushReceipt } from './receipts.ts'
import { pushDeliveries } from './tables.ts'
import { PushTargets } from './targets.ts'
import { fixture, pushTestLayer, PushProbe, testPushConfig } from './testing.ts'

const encodePayload = Schema.encodeSync(Schema.fromJsonString(PushPayload))
const encodeReceipt = Schema.encodeSync(PushReceipt)
const decodeReceipt = Schema.decodeUnknownEffect(PushReceipt)

/** Assertions inspect the public receipt without building counterfeit tagged variants. */
const pushOf = (outcome: NotifyPersonOutcome) => {
  if (!NotifyPersonOutcome.guards.Created(outcome)) expect.fail('Expected a stored Notification')
  return outcome.push
}

/** Replay uses the same source Notification, so the real ledger decides the send count. */
const notice = (owner: Effect.Success<ReturnType<typeof fixture>>) => {
  const id = NotificationId.make(NodeCrypto.randomUUID())
  const words = {
    personId: owner.person.id,
    companyId: null,
    kind: 'needs-you' as const,
    title: 'The reply is overdue',
    body: 'Please review\n the draft.',
    threadId: owner.threadId,
  }
  return { id, notice: words }
}

/** Each scoped test builds a fresh presence/adapter Layer while retaining real SQL semantics. */
describe.skipIf(!testDatabaseConfigured)('push delivery and registration handlers', () => {
  it.effect('registers idempotently, lists only the owner, removes, and cascades session end', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(pushTestLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fixture()
          const other = yield* fixture()
          const request = { destination: owner.destination }
          const first = yield* pushHandlers
            .RegisterPushTarget(request)
            .pipe(Effect.provideService(AuthContext, owner.auth))
          expect(
            yield* pushHandlers.GetPushKey().pipe(Effect.provideService(AuthContext, owner.auth)),
          ).toEqual({ publicKey: testPushConfig.publicKey })
          const repeated = yield* pushHandlers
            .RegisterPushTarget(request)
            .pipe(Effect.provideService(AuthContext, owner.auth))
          expect(repeated.target.id).toBe(first.target.id)
          expect(
            (yield* pushHandlers
              .ListPushTargets()
              .pipe(Effect.provideService(AuthContext, owner.auth))).targets,
          ).toHaveLength(1)
          const watched = yield* pushHandlers
            .WatchPushTargets()
            .pipe(Stream.runHead, Effect.provideService(AuthContext, owner.auth))
          expect(Option.isSome(watched) && watched.value.targets).toHaveLength(1)
          expect(
            (yield* pushHandlers
              .ListPushTargets()
              .pipe(Effect.provideService(AuthContext, other.auth))).targets,
          ).toEqual([])
          const conflict = yield* pushHandlers
            .RegisterPushTarget(request)
            .pipe(Effect.provideService(AuthContext, other.auth), Effect.result)
          expect(Result.isFailure(conflict) && conflict.failure._tag).toBe('Conflict')
          yield* pushHandlers
            .RemovePushTarget({ id: first.target.id })
            .pipe(Effect.provideService(AuthContext, other.auth))
          expect(yield* (yield* PushTargets).list(owner.person.id)).toHaveLength(1)
          yield* pushHandlers
            .RemovePushTarget({ id: first.target.id })
            .pipe(Effect.provideService(AuthContext, owner.auth))
          expect(yield* (yield* PushTargets).list(owner.person.id)).toEqual([])
          yield* pushHandlers
            .RegisterPushTarget(request)
            .pipe(Effect.provideService(AuthContext, owner.auth))
          yield* owner.database.run(
            owner.database.delete(sessionTable).where(eq(sessionTable.id, owner.sessionId)),
          )
          expect(yield* (yield* PushTargets).active(owner.person.id)).toEqual([])
          const outcome = yield* recordNotice(notice(owner))
          expect(pushOf(outcome)).toEqual(PushOutcome.cases.NoTargets.make({}))
          expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(0)
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'a session transfer survives old-session deletion and an old Expo gone receipt; expiry prunes it',
    () =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(pushTestLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* fixture()
            const targets = yield* PushTargets
            const old = yield* targets.register({
              personId: owner.person.id,
              sessionId: owner.sessionId,
              destination: owner.destination,
            })
            const probe = yield* PushProbe
            yield* Ref.set(probe.mode, 'Phone')
            yield* recordNotice(notice(owner))
            // Session identifiers stay server-side; create a fresh legitimate signed-in session for transfer.
            const id = SessionId.make(NodeCrypto.randomUUID())
            const now = yield* Clock.currentTimeMillis
            yield* owner.database.run(
              owner.database.insert(sessionTable).values({
                id,
                userId: owner.person.id,
                token: NodeCrypto.randomUUID(),
                expiresAt: new Date(now + 3_600_000),
              }),
            )
            const fresh = yield* targets.register({
              personId: owner.person.id,
              sessionId: id,
              destination: owner.destination,
            })
            expect(fresh.id).not.toBe(old.id)
            yield* owner.database.run(
              owner.database.delete(sessionTable).where(eq(sessionTable.id, owner.sessionId)),
            )
            yield* Ref.set(probe.receipt, Option.some('Gone'))
            yield* TestClock.adjust('15 minutes')
            yield* (yield* Push).reconcile
            expect((yield* targets.list(owner.person.id)).map((target) => target.id)).toEqual([
              fresh.id,
            ])
            yield* TestClock.adjust('46 minutes')
            expect(yield* targets.active(owner.person.id)).toEqual([])
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  it.effect('sends once per target across concurrent retry and rebuilding the delivery Layer', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(pushTestLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fixture()
          const targets = yield* PushTargets
          yield* targets.register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: owner.destination,
          })
          yield* targets.register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: PushDestination.cases.Phone.make({
              token: `ExpoPushToken[${NodeCrypto.randomUUID()}]`,
            }),
          })
          const input = notice(owner)
          yield* Effect.all([recordNotice(input), recordNotice(input)], { concurrency: 2 })
          const context = yield* Effect.context<
            | import('../database/client.ts').Database
            | import('./adapter.ts').PushAdapter
            | PushTargets
            | Presence
            | PushConfig
          >()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const caseContext = yield* Layer.build(Layer.fresh(pushLayer))
              return yield* Effect.gen(function* () {
                const rebuilt = yield* Push
                expect(yield* rebuilt.deliver(owner.person.id, input.id)).toEqual(
                  PushOutcome.cases.Attempted.make({ accepted: 2, failed: 0, uncertain: 0 }),
                )
              }).pipe(Effect.provide(caseContext))
            }).pipe(Effect.scoped, Effect.provideContext(context)),
          )
          const sent = yield* Ref.get((yield* PushProbe).sent)
          expect(sent).toHaveLength(2)
          const payload = sent[0]
          if (payload === undefined) expect.fail('Expected the provider payload')
          expect(sent[0]).toMatchObject({
            title: input.notice.title,
            body: 'Please review the draft.',
            threadId: owner.threadId,
          })
          expect(JSON.stringify(sent)).not.toContain(owner.person.id)
          const rows = yield* owner.database.run(
            owner.database
              .select()
              .from(pushDeliveries)
              .where(eq(pushDeliveries.notificationId, input.id)),
          )
          expect(rows).toHaveLength(2)
          expect(rows[0]).toMatchObject({ bodyLength: Buffer.byteLength(encodePayload(payload)) })
          expect(JSON.stringify(rows)).not.toContain('Please review')
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'suppresses push while present in any Thread, then uses the controlled presence expiry',
    () =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(pushTestLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* fixture()
            yield* (yield* PushTargets).register({
              personId: owner.person.id,
              sessionId: owner.sessionId,
              destination: owner.destination,
            })
            const presence = yield* Presence
            yield* presence.report(
              owner.threadId,
              { id: owner.person.id, name: owner.person.name, image: null },
              false,
            )
            const input = notice(owner)
            expect(pushOf(yield* recordNotice(input))).toEqual(PushOutcome.cases.Present.make({}))
            expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(0)
            yield* TestClock.adjust('16 seconds')
            expect(yield* (yield* Push).deliver(owner.person.id, input.id)).toMatchObject({
              accepted: 1,
            })
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  it.effect(
    'removes gone destinations and never retries uncertain or committed queued claims',
    () =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(pushTestLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* fixture()
            const targets = yield* PushTargets
            const probe = yield* PushProbe
            yield* targets.register({
              personId: owner.person.id,
              sessionId: owner.sessionId,
              destination: owner.destination,
            })
            yield* Ref.set(probe.mode, 'Gone')
            expect(yield* recordNotice(notice(owner))).toMatchObject({
              push: { accepted: 0, failed: 1 },
            })
            expect(yield* targets.list(owner.person.id)).toEqual([])
            const target = yield* targets.register({
              personId: owner.person.id,
              sessionId: owner.sessionId,
              destination: owner.destination,
            })
            yield* Ref.set(probe.mode, 'Uncertain')
            const input = notice(owner)
            yield* recordNotice(input)
            expect(yield* recordNotice(input)).toMatchObject({
              push: { accepted: 0, uncertain: 1 },
            })
            yield* owner.database.run(
              owner.database
                .update(pushDeliveries)
                .set({ receipt: encodeReceipt(PushReceipt.cases.Queued.make({})) })
                .where(eq(pushDeliveries.targetId, target.id)),
            )
            yield* recordNotice(input)
            expect(yield* Ref.get(probe.sent)).toHaveLength(2)
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  it.effect('removes Expo tokens reported gone by a delayed device receipt without resending', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(pushTestLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fixture()
          const probe = yield* PushProbe
          yield* Ref.set(probe.mode, 'Phone')
          yield* (yield* PushTargets).register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: owner.destination,
          })
          const input = notice(owner)
          yield* recordNotice(input)
          yield* Ref.set(probe.receipt, Option.some('Gone'))
          yield* TestClock.adjust('15 minutes')
          yield* (yield* Push).reconcile
          expect(yield* (yield* PushTargets).list(owner.person.id)).toEqual([])
          const [row] = yield* owner.database.run(
            owner.database
              .select()
              .from(pushDeliveries)
              .where(eq(pushDeliveries.notificationId, input.id)),
          )
          if (row === undefined) expect.fail('Expected the durable delivery receipt')
          expect(yield* decodeReceipt(row.receipt)).toMatchObject(
            PushReceipt.cases.Failed.make({ reason: 'Gone' }),
          )
          expect(yield* Ref.get(probe.sent)).toHaveLength(1)
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect('checks access again before quoting private Thread content', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(pushTestLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* fixture()
          const other = yield* fixture()
          yield* (yield* PushTargets).register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: owner.destination,
          })
          yield* owner.database.run(
            owner.database
              .update(threads)
              .set({ personId: other.person.id })
              .where(eq(threads.id, owner.threadId)),
          )
          expect(pushOf(yield* recordNotice(notice(owner)))).toEqual(
            PushOutcome.cases.NoTargets.make({}),
          )
          expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(0)
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'notify_person returns provider evidence, deduplicates in its acting Run, and a standing Run stays quiet',
    () =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(pushTestLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* fixture()
            yield* (yield* PushTargets).register({
              personId: owner.person.id,
              sessionId: owner.sessionId,
              destination: owner.destination,
            })
            const runs = yield* RunStore
            const id = RunId.make(NodeCrypto.randomUUID())
            const reserved = yield* runs.start({
              id,
              threadId: owner.threadId,
              personId: owner.person.id,
              origin: StoredRunOrigin.cases.Standing.make({ routineName: 'Watch what needs me' }),
              libraryFolder: null,
            })
            if (!TurnReservation.guards.Reserved(reserved))
              expect.fail('Expected a fresh Run reservation')
            yield* runs.admitted({ runId: id, offset: '0', incarnation: 'test' })
            expect(yield* automaticallyNotifies(id)).toBe(false)
            const auth = AuthState.Vivid({
              person: owner.person,
              workspace: owner.auth.workspace,
              threadId: owner.threadId,
            })
            const message = {
              title: 'Decision needed',
              body: 'The meeting clashes with your train.',
            }
            const response = yield* pushHandlers
              .NotifyPerson(message)
              .pipe(Effect.provideService(AuthContext, auth))
            expect(pushOf(response)).toMatchObject({ accepted: 1 })
            yield* pushHandlers.NotifyPerson(message).pipe(Effect.provideService(AuthContext, auth))
            expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(1)
            expect(
              yield* owner.database.run(
                owner.database
                  .select()
                  .from(notifications)
                  .where(eq(notifications.personId, owner.person.id)),
              ),
            ).toHaveLength(1)
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )
})

/** The public key is for a signed-in Person's browser; Vivid's own runtime identity has no use for it. */
it.effect('refuses the push key to a caller that is not a Person', () =>
  Effect.gen(function* () {
    const result = yield* pushHandlers
      .GetPushKey()
      .pipe(
        Effect.provideService(AuthContext, AuthState.Runtime()),
        Effect.provideService(PushConfig, testPushConfig),
        Effect.result,
      )
    expect(Result.isFailure(result) && result.failure._tag).toBe('Forbidden')
  }),
)
