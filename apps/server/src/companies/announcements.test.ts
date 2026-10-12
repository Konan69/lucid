import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  AuditEvent,
  CompanyId,
  Conflict,
  Forbidden,
  InvitationId,
  MembershipId,
  PersonId,
  PersonSummary,
  SessionId,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { auditEntries } from '../audit/tables.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, Changes, changesLayer, Topic } from '../live/changes.ts'
import { watch } from '../live/query.ts'
import { CompanyStore, companyStoreLayer } from './store.ts'
import { companyTable, invitationTable, membershipTable } from './tables.ts'

const testLayer = Layer.merge(companyStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const decodeEvent = decodeStored(AuditEvent, 'audit event')

/** Register cleanup before seeding either Person, so every failed setup leaves an empty clone. */
const fixture = Effect.fn('CompanyAnnouncements.fixture')(function* () {
  const database = yield* Database
  const owner = PersonSummary.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Owner',
    image: null,
  })
  const person = PersonSummary.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Member',
    image: null,
  })
  const companyId = CompanyId.make(crypto.randomUUID())
  const ownerMembership = MembershipId.make(crypto.randomUUID())
  const membershipId = MembershipId.make(crypto.randomUUID())
  const sessionId = SessionId.make(crypto.randomUUID())
  const email = `${person.id}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(companyTable).where(eq(companyTable.id, companyId))).pipe(
      Effect.andThen(
        database.run(
          database.delete(personTable).where(inArray(personTable.id, [owner.id, person.id])),
        ),
      ),
      Effect.asVoid,
      Effect.catch(() =>
        Effect.sync(() => expect.fail('Company announcement fixture cleanup failed')),
      ),
    ),
  )
  yield* database.run(
    database.insert(personTable).values([
      { id: owner.id, name: owner.name, email: `${owner.id}@example.test`, emailVerified: true },
      { id: person.id, name: person.name, email, emailVerified: true },
    ]),
  )
  yield* database.run(
    database.insert(companyTable).values({ id: companyId, name: 'Company', slug: companyId }),
  )
  yield* database.run(
    database
      .insert(membershipTable)
      .values({ id: ownerMembership, companyId, userId: owner.id, role: 'owner' }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: owner.id,
      token: crypto.randomUUID(),
      expiresAt: new Date('2100-01-01T00:00:00Z'),
    }),
  )
  return { owner, person, companyId, ownerMembership, membershipId, sessionId, email }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Seed a member without announcing: watches open only after the starting state is persisted. */
const member = Effect.fn('CompanyAnnouncements.member')(function* (test: Fixture) {
  const database = yield* Database
  yield* database.run(
    database.insert(membershipTable).values({
      id: test.membershipId,
      companyId: test.companyId,
      userId: test.person.id,
      role: 'member',
    }),
  )
})

/** Seed an offer directly to exercise acceptance failures as well as the public invite operation. */
const invitation = Effect.fn('CompanyAnnouncements.invitation')(function* (
  test: Fixture,
  status: 'pending' | 'accepted',
) {
  const database = yield* Database
  const id = InvitationId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(invitationTable).values({
      id,
      companyId: test.companyId,
      email: test.email,
      role: 'admin',
      status,
      expiresAt: new Date('2100-01-01T00:00:00Z'),
      inviterId: test.owner.id,
    }),
  )
  return id
})

/**
 * Observe the public watch, never a fake bus. Its first emitted value confirms subscription and
 * loading. A companion real Changes subscription receives the actual PostgreSQL notice before
 * TestClock advances watch's 20 ms debounce (rc.116 Stream.ts debounce; TestClock.ts adjust).
 * Queue values are complete loader results; equal reloads cannot satisfy a second-value assertion.
 */
const observing = Effect.fn('CompanyAnnouncements.observing')(function* <A, E, R>(
  topics: ReadonlyArray<Topic>,
  load: Effect.Effect<A, E, R>,
) {
  const first = yield* Deferred.make<void>()
  const values = yield* Queue.unbounded<A>()
  const fiber = yield* watch('Session', topics, load).pipe(
    Stream.runForEach((value) =>
      Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
    ),
    Effect.forkScoped,
  )
  yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
  const initial = yield* Queue.take(values)
  const receipt = yield* (yield* Changes).subscribe(topics)
  return { initial, values, receipt, fiber }
})

/** Advance only after the real bus receipt, then take the next distinct public loader result. */
const nextValue = Effect.fn('CompanyAnnouncements.nextValue')(function* <A, E>(observation: {
  readonly values: Queue.Queue<A>
  readonly receipt: Stream.Stream<void>
  readonly fiber: Fiber.Fiber<void, E>
}) {
  expect(Option.isSome(yield* Stream.runHead(observation.receipt))).toBe(true)
  yield* TestClock.adjust('20 millis')
  return yield* Effect.raceFirst(
    Queue.take(observation.values),
    Fiber.join(observation.fiber).pipe(Effect.andThen(Effect.never)),
  )
})

/** Decode persisted audit JSON at its only ingress; attribution is read from the stored row. */
const audit = Effect.fn('CompanyAnnouncements.audit')(function* (test: Fixture) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(auditEntries).where(eq(auditEntries.companyId, test.companyId)),
  )
  return yield* Effect.forEach(rows, (row) =>
    decodeEvent(row.event).pipe(
      Effect.map((event) => ({
        personId: row.personId,
        companyId: row.companyId,
        by: row.by,
        threadId: row.threadId,
        event,
      })),
    ),
  )
})

/** A committed enter is an ordered marker on PostgreSQL's queue, proving rollback sent nothing. */
const marker = Effect.fn('CompanyAnnouncements.marker')(function* (
  test: Fixture,
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
) {
  yield* (yield* CompanyStore).enter(test.owner.id, test.sessionId, Option.some(test.companyId))
  expect((yield* Queue.take(notifications)).payload).toBe(
    JSON.stringify([Topic.person(test.owner.id)]),
  )
})

describe.skipIf(!testDatabaseConfigured)('Company transaction announcements', () => {
  layer(testLayer)('isolated clock 1', (it) => {
    it.effect('reloads the removed Person and Company and appends one removal audit', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* member(test)
        const store = yield* CompanyStore
        const personal = yield* observing(
          [Topic.person(test.person.id)],
          store.memberships(test.person.id),
        )
        const company = yield* observing(
          [Topic.company(test.companyId)],
          store.members(test.companyId),
        )
        expect(personal.initial).toHaveLength(1)
        expect(company.initial).toHaveLength(2)
        yield* store.remove(test.owner.id, test.companyId, test.membershipId)
        expect(yield* nextValue(personal)).toEqual([])
        expect(yield* nextValue(company)).toEqual([expect.objectContaining({ person: test.owner })])
        expect(yield* audit(test)).toEqual([
          {
            personId: test.owner.id,
            companyId: test.companyId,
            by: 'person',
            threadId: null,
            event: AuditEvent.cases.MemberRemoved.make({ name: test.person.name }),
          },
        ])
      }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 2', (it) => {
    it.effect('reloads the Member and Company with the changed role', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* member(test)
        const store = yield* CompanyStore
        const personal = yield* observing(
          [Topic.person(test.person.id)],
          store.memberships(test.person.id),
        )
        const company = yield* observing(
          [Topic.company(test.companyId)],
          store.members(test.companyId),
        )
        yield* store.changeRole(test.owner.id, test.companyId, test.membershipId, 'admin')
        expect(yield* nextValue(personal)).toEqual([expect.objectContaining({ role: 'admin' })])
        expect(yield* nextValue(company)).toContainEqual(
          expect.objectContaining({ person: test.person, role: 'admin' }),
        )
        expect(yield* audit(test)).toEqual([
          expect.objectContaining({
            personId: test.owner.id,
            event: AuditEvent.cases.RoleChanged.make({ name: test.person.name, role: 'admin' }),
          }),
        ])
      }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 3', (it) => {
    it.effect(
      'reloads Company and Person after accepting and records the explicit Person name',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const id = yield* invitation(test, 'pending')
          const store = yield* CompanyStore
          const personal = yield* observing(
            [Topic.person(test.person.id)],
            store.memberships(test.person.id),
          )
          const company = yield* observing(
            [Topic.company(test.companyId)],
            store.members(test.companyId),
          )
          expect(personal.initial).toEqual([])
          const person = { id: test.person.id, name: 'Current signed-in name' }
          yield* store.accept(person, id)
          expect(yield* nextValue(personal)).toEqual([
            expect.objectContaining({
              company: expect.objectContaining({ id: test.companyId }),
              role: 'admin',
            }),
          ])
          expect(yield* nextValue(company)).toContainEqual(
            expect.objectContaining({ person: test.person, role: 'admin' }),
          )
          expect(yield* audit(test)).toEqual([
            expect.objectContaining({
              personId: person.id,
              event: AuditEvent.cases.MemberJoined.make({ name: person.name, role: 'admin' }),
            }),
          ])
        }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 4', (it) => {
    it.effect('reloads Company invitations after invite and revoke', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* CompanyStore
        const company = yield* observing(
          [Topic.company(test.companyId)],
          store.invitations(test.companyId),
        )
        expect(company.initial).toEqual([])
        const offer = yield* store.invite(test.owner.id, test.companyId, {
          email: test.email,
          role: 'admin',
        })
        expect(yield* nextValue(company)).toEqual([offer])
        yield* store.revoke(test.companyId, offer.id)
        expect(yield* nextValue(company)).toEqual([])
        expect(yield* audit(test)).toEqual([
          expect.objectContaining({
            personId: test.owner.id,
            event: AuditEvent.cases.MemberInvited.make({ email: test.email, role: 'admin' }),
          }),
        ])
      }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)((it) => {
    it.effect('rolls back an already-used acceptance before an ordered enter marker', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* invitation(test, 'accepted')
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const store = yield* CompanyStore
        expect(yield* store.accept(test.person, id).pipe(Effect.flip)).toBeInstanceOf(Conflict)
        yield* marker(test, notifications)
        expect(yield* store.memberships(test.person.id)).toEqual([])
        expect(yield* audit(test)).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('keeps the invitation pending when already a Member accepts', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* member(test)
        const id = yield* invitation(test, 'pending')
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const store = yield* CompanyStore
        expect(yield* store.accept(test.person, id).pipe(Effect.flip)).toEqual(
          new Conflict({ message: 'You are already a Member' }),
        )
        expect(yield* store.invitations(test.companyId)).toEqual([
          expect.objectContaining({ id, status: 'pending' }),
        ])
        yield* marker(test, notifications)
        expect(yield* store.memberships(test.person.id)).toEqual([
          expect.objectContaining({ role: 'member' }),
        ])
        expect(yield* audit(test)).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('refuses removing the owner and emits only the ordered enter marker', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const store = yield* CompanyStore
        expect(
          yield* store
            .remove(test.owner.id, test.companyId, test.ownerMembership)
            .pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        yield* marker(test, notifications)
        expect(yield* store.members(test.companyId)).toEqual([
          expect.objectContaining({ person: test.owner, role: 'owner' }),
        ])
        expect(yield* audit(test)).toEqual([])
      }).pipe(Effect.scoped),
    )
  })
})
