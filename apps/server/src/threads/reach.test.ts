import { describe, expect, layer } from '@effect/vitest'
import {
  Company,
  CompanyId,
  DatabaseFailure,
  NotFound,
  Person,
  PersonId,
  ShareThreadRequest,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Option, Result } from 'effect'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { canSee, requireThread } from './access.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import { threadParticipants, threads } from './tables.ts'

const testLayer = threadStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

/** Fresh People and Company isolate real rows; cascaded cleanup is registered before any write. */
const fixture = Effect.fn('ThreadReach.fixture')(function* () {
  const database = yield* Database
  const people = ['Creator', 'Ben', 'Cy', 'Dee'].map((name) =>
    Person.make({
      id: PersonId.make(crypto.randomUUID()),
      name,
      email: `${crypto.randomUUID()}@reach.test`,
      image: null,
    }),
  )
  const [creator, ben, cy, dee] = people
  if (creator === undefined || ben === undefined || cy === undefined || dee === undefined)
    return yield* Effect.sync(() => expect.fail('Fixture People missing'))
  const company = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Reach Company',
    slug: crypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const cleanup = yield* Effect.result(
        database.run(database.delete(companyTable).where(eq(companyTable.id, company.id))).pipe(
          Effect.andThen(
            database.run(
              database.delete(personTable).where(
                inArray(
                  personTable.id,
                  people.map((p) => p.id),
                ),
              ),
            ),
          ),
        ),
      )
      expect(Result.isSuccess(cleanup)).toBe(true)
    }),
  )
  yield* database.run(database.insert(personTable).values(people))
  yield* database.run(database.insert(companyTable).values(company))
  yield* database.run(
    database.insert(membershipTable).values(
      [creator, ben, cy].map((person) => ({
        id: crypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: person.id === ben.id ? 'owner' : 'member',
      })),
    ),
  )
  /** Even Dee carries the Company: a captured workspace must not replace current Membership. */
  const actor = (person: Person): Actor => ({
    person,
    workspace: Workspace.cases.Company.make({
      company,
      role: person.id === ben.id ? 'owner' : 'member',
    }),
    by: 'person',
    threadId: Option.none(),
  })
  /** Personal navigation stays separate from a Person's Memberships elsewhere. */
  const personal = (person: Person): Actor => ({
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  })
  return { creator, ben, cy, dee, company, actor, personal }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Direct setup can deliberately store an invalid audience, exercising the real decode boundary. */
const seed = Effect.fn('ThreadReach.seed')(function* (
  test: Fixture,
  audience: string,
  companyId: CompanyId | null,
  participants: ReadonlyArray<PersonId>,
) {
  const database = yield* Database
  const id = ThreadId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(threads).values({
      id,
      personId: test.creator.id,
      companyId,
      title: 'Reach test Thread',
      titleSource: 'Seed',
      audience,
      updatedAt: 0,
    }),
  )
  if (participants.length > 0)
    yield* database.run(
      database
        .insert(threadParticipants)
        .values(participants.map((personId) => ({ threadId: id, personId, addedAt: 0 }))),
    )
  return id
})

/** All three public readers must agree for valid rows, including absent ids and stale Actors. */
const reach = Effect.fn('ThreadReach.check')(function* (
  actor: Actor,
  id: ThreadId,
  expected: boolean,
) {
  expect(yield* canSee(id, actor.person.id)).toBe(expected)
  if (expected) expect((yield* requireThread(id, actor.person.id)).id).toBe(id)
  else
    expect(yield* requireThread(id, actor.person.id).pipe(Effect.flip)).toEqual(
      new NotFound({ message: 'Thread not found' }),
    )
  const listed = yield* (yield* ThreadStore).list(actor)
  expect(listed.some((thread) => thread.id === id)).toBe(expected)
})

/** Authority is read from the Thread's Company, never the role or stale Company in an Actor. */
describe.skipIf(!testDatabaseConfigured)('Thread reach', () => {
  layer(testLayer)((it) => {
    it.effect('R1 personal, private, named and Company reach agree across all three readers', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const own = yield* seed(test, 'private', null, [])
        const privateId = yield* seed(test, 'private', test.company.id, [])
        const named = yield* seed(test, 'people', test.company.id, [test.ben.id])
        const company = yield* seed(test, 'company', test.company.id, [])
        const cases = [
          { id: own, actor: test.personal(test.creator), expected: true },
          { id: own, actor: test.personal(test.ben), expected: false },
          { id: privateId, actor: test.actor(test.creator), expected: true },
          { id: privateId, actor: test.actor(test.cy), expected: false },
          { id: privateId, actor: test.actor(test.ben), expected: false },
          { id: named, actor: test.actor(test.creator), expected: true },
          { id: named, actor: test.actor(test.ben), expected: true },
          { id: named, actor: test.actor(test.cy), expected: false },
          { id: company, actor: test.actor(test.cy), expected: true },
          { id: company, actor: test.actor(test.dee), expected: false },
          {
            id: ThreadId.make(crypto.randomUUID()),
            actor: test.actor(test.creator),
            expected: false,
          },
        ]
        for (const item of cases) yield* reach(item.actor, item.id, item.expected)
      }).pipe(Effect.scoped),
    )

    it.effect('R1 leftover participants never widen a private Thread list', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* seed(test, 'private', test.company.id, [test.ben.id])
        yield* reach(test.actor(test.ben), id, false)
      }).pipe(Effect.scoped),
    )

    it.effect('R1 a captured Company Actor loses list reach when Membership is removed', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* seed(test, 'company', test.company.id, [])
        const actor = test.actor(test.cy)
        yield* reach(actor, id, true)
        const database = yield* Database
        yield* database.run(
          database
            .delete(membershipTable)
            .where(
              and(
                eq(membershipTable.companyId, test.company.id),
                eq(membershipTable.userId, test.cy.id),
              ),
            ),
        )
        yield* reach(actor, id, false)
      }).pipe(Effect.scoped),
    )

    it.effect('R2 share, re-share, Membership loss and deletion change current reach', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* seed(test, 'people', test.company.id, [test.ben.id])
        const store = yield* ThreadStore
        const actor = test.actor(test.ben)
        yield* reach(actor, id, true)
        yield* store.share(test.creator.id, id, ShareThreadRequest.cases.Private.make({}))
        yield* reach(actor, id, false)
        yield* store.share(
          test.creator.id,
          id,
          ShareThreadRequest.cases.People.make({ participants: [test.ben.id] }),
        )
        yield* reach(actor, id, true)
        const database = yield* Database
        yield* database.run(
          database
            .delete(membershipTable)
            .where(
              and(
                eq(membershipTable.companyId, test.company.id),
                eq(membershipTable.userId, test.ben.id),
              ),
            ),
        )
        yield* reach(actor, id, false)
        yield* store.remove(test.creator.id, id)
        yield* reach(test.actor(test.creator), id, false)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'R3 corruption fails decoded reads first and fails closed in non-decoding readers',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const id = yield* seed(test, 'everyone', test.company.id, [test.ben.id])
          const failure = new DatabaseFailure({ message: 'Database returned an invalid Thread' })
          for (const person of [test.creator, test.cy]) {
            expect(yield* requireThread(id, person.id).pipe(Effect.flip)).toEqual(failure)
            expect(yield* canSee(id, person.id)).toBe(false)
          }
          const store = yield* ThreadStore
          expect(yield* store.list(test.actor(test.creator)).pipe(Effect.flip)).toEqual(failure)
          expect(yield* store.list(test.actor(test.cy))).toEqual([])
          expect(yield* store.list(test.actor(test.ben))).toEqual([])
        }).pipe(Effect.scoped),
    )
  })
})
