import { describe, expect, it } from '@effect/vitest'
import { ApprovalDecision, Conflict, DatabaseFailure, RuntimeUnavailable } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Ref, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { refusalLogs } from '../observability/testlogger.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { DeliverySpeaker } from '../threads/conversation.ts'
import { threads } from '../threads/tables.ts'
import { ApprovalStore, approvalStoreLayer } from './store.ts'
import { approvals } from './tables.ts'
import { approvalSweeperLayer } from './sweeper.ts'
import { commandAction, fixture, Observation, trustTestLayer } from './testing.ts'

const isDatabaseFailure = Schema.is(DatabaseFailure)

const deny = ApprovalDecision.cases.Deny.make({})

/** PostgreSQL owns debts and leases; abrupt defects represent a lost process without undoing SQL. */
describe.skipIf(!testDatabaseConfigured)('Durable Approval signals', () => {
  for (const failure of [
    new Conflict({ message: 'Busy' }),
    new RuntimeUnavailable({ message: 'Unavailable' }),
    new DatabaseFailure({ message: 'Private diagnostic must not enter logs' }),
  ]) {
    it.effect(`replay retains debt and logs only unexpected ${failure._tag} once`, () => {
      const logged: string[] = []
      const refusals = refusalLogs()
      // This assertion owns unexpected error diagnostics; refusal info lines are a separate receipt.
      const logger = Logger.make(({ message, logLevel }) => {
        if (logLevel === 'Error') logged.push(JSON.stringify(message))
      })
      return Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ApprovalStore
        const observed = yield* Observation
        yield* Ref.set(observed.deliveryFailure, Option.some(failure))
        const approval = yield* store.raise(test.vivid, commandAction)
        yield* store.decide(test.personal, {
          id: approval.id,
          digest: approval.digest,
          decision: deny,
        })
        expect(logged).toHaveLength(isDatabaseFailure(failure) ? 1 : 0)
        if (isDatabaseFailure(failure)) {
          expect(JSON.stringify(logged)).toContain('DatabaseFailure')
          expect(JSON.stringify(logged)).not.toContain(failure.message)
        }
        yield* Ref.set(observed.deliveryFailure, Option.none())
        yield* TestClock.adjust('2 minutes')
        yield* store.replay()
        yield* store.replay()
        const deliveries = yield* Ref.get(observed.deliveries)
        expect(deliveries).toHaveLength(2)
        expect(deliveries.map((delivery) => delivery.idempotencyKey)).toEqual([
          (yield* returned(deliveries, 'Delivery')).idempotencyKey,
          (yield* returned(deliveries, 'Delivery')).idempotencyKey,
        ])
        expect(logged).toHaveLength(isDatabaseFailure(failure) ? 1 : 0)
        expect(refusals.recorded()).toHaveLength(1)
        expect(refusals.recorded()[0]).toContain('vivid.refusal.kind=ApprovalDenied')
      }).pipe(
        Effect.scoped,
        Effect.provide(trustTestLayer),
        Effect.provide(refusals.layer),
        Effect.provide(Logger.layer([logger])),
      )
    })
  }

  it.effect(
    'a shared Thread decision carries its decider while continuing the asked Person authority',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const store = yield* ApprovalStore
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'company' })
            .where(eq(threads.id, test.companyId)),
        )
        const approval = yield* store.raise(test.companyVivid, commandAction)
        yield* store.decide(test.owner, {
          id: approval.id,
          digest: approval.digest,
          decision: deny,
        })
        const delivered = yield* Ref.get((yield* Observation).deliveries)
        expect(delivered).toMatchObject([
          {
            personId: test.member.person.id,
            speaker: DeliverySpeaker.cases.Decider.make({ personId: test.owner.person.id }),
          },
        ])
        const rows = yield* database.run(
          database.select().from(approvals).where(eq(approvals.id, approval.id)),
        )
        expect(rows).toMatchObject([{ decidedBy: test.owner.person.id }])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('crash after decision and before admission is replayed by a fresh store', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      const approval = yield* store.raise(test.vivid, commandAction)
      yield* Ref.set(observed.changesDefect, true)
      const crash = yield* Effect.exit(
        store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: deny }),
      )
      expect(Exit.isFailure(crash)).toBe(true)
      expect(yield* Ref.get(observed.deliveries)).toEqual([])
      yield* Ref.set(observed.changesDefect, false)
      yield* TestClock.adjust('30 seconds')
      yield* Effect.gen(function* () {
        yield* (yield* ApprovalStore).replay()
      }).pipe(Effect.provide(approvalStoreLayer))
      expect(yield* Ref.get(observed.deliveries)).toEqual([
        expect.objectContaining({ idempotencyKey: `approval-${approval.id}` }),
      ])
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('the scoped startup worker admits debt without waiting for its first interval', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      const approval = yield* store.raise(test.vivid, commandAction)
      yield* Ref.set(observed.changesDefect, true)
      yield* Effect.exit(
        store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: deny }),
      )
      yield* Ref.set(observed.changesDefect, false)
      yield* Layer.build(approvalSweeperLayer)
      yield* Queue.take(observed.admissionStarted)
      expect(
        (yield* Ref.get(observed.deliveries)).map((delivery) => delivery.idempotencyKey),
      ).toContain(`approval-${approval.id}`)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a failed admission retries with its original key and then stops', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      const approval = yield* store.raise(test.vivid, commandAction)
      yield* Ref.set(
        observed.deliveryFailure,
        Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
      )
      yield* store.decide(test.personal, {
        id: approval.id,
        digest: approval.digest,
        decision: deny,
      })
      yield* Ref.set(observed.deliveryFailure, Option.none())
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toHaveLength(1)
      yield* TestClock.adjust('30 seconds')
      yield* store.replay()
      yield* store.replay()
      expect(
        (yield* Ref.get(observed.deliveries)).map((delivery) => delivery.idempotencyKey),
      ).toEqual([`approval-${approval.id}`, `approval-${approval.id}`])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect(
    'Thread deletion cascades pending and owed Approvals and never replays tombstones',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ApprovalStore
        const observed = yield* Observation
        const database = yield* Database
        const approval = yield* store.raise(test.vivid, commandAction)
        yield* Ref.set(observed.changesDefect, true)
        yield* Effect.exit(
          store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: deny }),
        )
        yield* Ref.set(observed.changesDefect, false)
        yield* store.raise(test.vivid, commandAction)
        yield* database.run(database.delete(threads).where(eq(threads.id, test.personalId)))
        expect(yield* store.inbox(test.personal)).toEqual([])
        expect(yield* store.inThread(test.personalId)).toEqual([])
        expect(
          yield* database.run(
            database.select().from(approvals).where(eq(approvals.threadId, test.personalId)),
          ),
        ).toEqual([])
        yield* store.replay()
        expect(yield* Ref.get(observed.deliveries)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('two workers cannot admit the same claimed debt concurrently', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      const approval = yield* store.raise(test.vivid, commandAction)
      yield* Ref.set(observed.changesDefect, true)
      yield* Effect.exit(
        store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: deny }),
      )
      yield* Ref.set(observed.changesDefect, false)
      const gate = yield* Deferred.make<void>()
      yield* Ref.set(observed.deliveryGate, Option.some(gate))
      const first = yield* store.replay().pipe(Effect.forkScoped)
      yield* Queue.take(observed.admissionStarted)
      yield* Effect.gen(function* () {
        yield* (yield* ApprovalStore).replay()
      }).pipe(Effect.provide(approvalStoreLayer))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      expect(
        (yield* Ref.get(observed.deliveries)).filter(
          (delivery) => delivery.idempotencyKey === `approval-${approval.id}`,
        ),
      ).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a crash after SQL claim is reclaimable when the lease expires', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      const approval = yield* store.raise(test.vivid, commandAction)
      yield* Ref.set(observed.deliveryDefect, true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.decide(test.personal, {
              id: approval.id,
              digest: approval.digest,
              decision: deny,
            }),
          ),
        ),
      ).toBe(true)
      yield* Ref.set(observed.deliveryDefect, false)
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toEqual([])
      yield* TestClock.adjust('2 minutes')
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
