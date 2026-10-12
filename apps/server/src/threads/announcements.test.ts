import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  AuditEvent,
  Company,
  CompanyId,
  Conflict,
  DatabaseConstraintViolation,
  Forbidden,
  InvalidRequest,
  NotFound,
  Person,
  PersonId,
  ProjectId,
  ShareThreadRequest,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { auditEntries } from '../audit/tables.ts'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { projectTable } from '../projects/tables.ts'
import { ProjectStore, projectStoreLayer } from '../projects/store.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import { threadParticipants, threadReads, threads } from './tables.ts'

const testLayer = Layer.mergeAll(threadStoreLayer, projectStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const decodeEvent = decodeStored(AuditEvent, 'audit event')

/** Seed only disposable rows, registering cascaded cleanup before the first insert. */
const fixture = Effect.fn('ThreadAnnouncements.fixture')(function* () {
  const database = yield* Database
  const people = ['Creator', 'Ben', 'Cy', 'Dee'].map((name) =>
    Person.make({
      id: PersonId.make(crypto.randomUUID()),
      name,
      email: `${crypto.randomUUID()}@example.test`,
      image: null,
    }),
  )
  const [creator, ben, cy, dee] = people
  if (creator === undefined || ben === undefined || cy === undefined || dee === undefined)
    return yield* Effect.sync(() => expect.fail('Fixture People missing'))
  const company = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Company',
    slug: crypto.randomUUID(),
  })
  const id = ThreadId.make(crypto.randomUUID())
  yield* Effect.addFinalizer(() =>
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
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Thread announcement cleanup failed'))),
    ),
  )
  yield* database.run(database.insert(personTable).values(people))
  yield* database.run(database.insert(companyTable).values(company))
  yield* database.run(
    database.insert(membershipTable).values(
      [creator, ben, cy].map((person) => ({
        id: crypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: 'member',
      })),
    ),
  )
  /** Actors deliberately carry a Company even for Dee, whose Membership is absent. */
  const actor = (person: Person): Actor => ({
    person,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    by: 'person',
    threadId: Option.none(),
  })
  return { creator, ben, cy, dee, company, id, actor }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Seed the initial audience directly so setup never contaminates a notification receipt. */
const seed = Effect.fn('ThreadAnnouncements.seed')(function* (
  test: Fixture,
  audience: 'private' | 'people' | 'company',
  people: ReadonlyArray<PersonId>,
) {
  const database = yield* Database
  yield* database.run(
    database.insert(threads).values({
      id: test.id,
      personId: test.creator.id,
      companyId: test.company.id,
      title: 'Initial title',
      titleSource: 'Seed',
      audience,
      updatedAt: 0,
    }),
  )
  if (people.length > 0)
    yield* database.run(
      database
        .insert(threadParticipants)
        .values(people.map((personId) => ({ threadId: test.id, personId, addedAt: 0 }))),
    )
})

/** Read persisted state and decode audit JSON rather than trusting a handler or stub. */
const stored = Effect.fn('ThreadAnnouncements.stored')(function* (test: Fixture) {
  const database = yield* Database
  const rows = yield* database.run(database.select().from(threads).where(eq(threads.id, test.id)))
  const participants = yield* database.run(
    database.select().from(threadParticipants).where(eq(threadParticipants.threadId, test.id)),
  )
  const audits = yield* database.run(
    database.select().from(auditEntries).where(eq(auditEntries.companyId, test.company.id)),
  )
  const events = yield* Effect.forEach(audits, (row) => decodeEvent(row.event))
  return { rows, participants, audits, events }
})

/** Each case crosses the production Database, store and LISTEN/NOTIFY seam. */
describe.skipIf(!testDatabaseConfigured)('Thread transaction announcements', () => {
  layer(testLayer)((it) => {
    it.effect('case1 create reads its uncommitted insert and read receipt', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const thread = yield* (yield* ThreadStore).create(test.actor(test.creator), {
          id: test.id,
          title: 'Created',
          projectId: null,
        })
        expect(thread.attention).toBe('Quiet')
        const database = yield* Database
        const reads = yield* database.run(
          database.select().from(threadReads).where(eq(threadReads.threadId, test.id)),
        )
        expect(reads).toEqual([
          { threadId: test.id, personId: test.creator.id, readAt: thread.updatedAt },
        ])
        yield* payload(notifications, [Topic.thread(test.id), Topic.person(test.creator.id)])
        expect(
          yield* (yield* ThreadStore).create(test.actor(test.creator), {
            id: test.id,
            title: 'Created',
            projectId: null,
          }),
        ).toEqual(thread)
        yield* silent(notifications)
      }),
    )
    it.effect('case2 create refuses missing Membership and rolls back', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const result = yield* (yield* ThreadStore)
          .create(test.actor(test.dee), { id: test.id, title: 'Refused', projectId: null })
          .pipe(Effect.flip)
        expect(result).toEqual(new Forbidden({ message: 'You are not a Member of this Company' }))
        expect((yield* stored(test)).rows).toEqual([])
        yield* silent(notifications)
      }),
    )
    /** A captured Actor is no authority after revocation, including idempotent create retries. */
    it.effect('case3b create retry conceals metadata after Membership removal', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ThreadStore
        const actor = test.actor(test.creator)
        const request = { id: test.id, title: 'Created', projectId: null }
        yield* store.create(actor, request)
        const database = yield* Database
        yield* database.run(
          database
            .delete(membershipTable)
            .where(
              and(
                eq(membershipTable.companyId, test.company.id),
                eq(membershipTable.userId, test.creator.id),
              ),
            ),
        )
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(yield* store.create(actor, request).pipe(Effect.flip)).toEqual(
          new Conflict({ message: 'That Thread id is taken' }),
        )
        expect((yield* stored(test)).rows).toEqual([expect.objectContaining({ title: 'Created' })])
        yield* silent(notifications)
      }),
    )
    layer(testLayer)('Clock case 1', (it) => {
      it.effect('case4 patch reloads a named participant with the committed title', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'people', [test.ben.id])
          const store = yield* ThreadStore
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(test.actor(test.ben)),
          )
          expect(observation.initial).toHaveLength(1)
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          yield* store.patch(test.creator.id, test.id, { title: 'Renamed' })
          yield* payload(notifications, [
            Topic.thread(test.id),
            Topic.person(test.creator.id),
            Topic.company(test.company.id),
            Topic.person(test.ben.id),
          ])
          expect(yield* nextValue(observation)).toEqual([
            expect.objectContaining({ title: 'Renamed' }),
          ])
        }),
      )
    })
    it.effect('case5 patch conceals an inaccessible Thread and writes nothing', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* seed(test, 'company', [])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* (yield* ThreadStore)
            .patch(test.dee.id, test.id, { title: 'Refused' })
            .pipe(Effect.flip),
        ).toEqual(new NotFound({ message: 'Thread not found' }))
        expect((yield* stored(test)).rows).toEqual([
          expect.objectContaining({ title: 'Initial title' }),
        ])
        yield* silent(notifications)
      }),
    )
    layer(testLayer)('Clock case 2', (it) => {
      it.effect('case6 narrowing Company to Private reloads people who lose access', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'company', [])
          const store = yield* ThreadStore
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(test.actor(test.ben)),
          )
          expect(observation.initial).toHaveLength(1)
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          yield* store.share(test.creator.id, test.id, ShareThreadRequest.cases.Private.make({}))
          yield* payload(notifications, [
            Topic.thread(test.id),
            Topic.person(test.creator.id),
            Topic.company(test.company.id),
          ])
          expect(yield* nextValue(observation)).toEqual([])
        }),
      )
    })
    it.effect(
      'case7 replacing named people announces both audiences and audits the Thread Company',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'people', [test.ben.id])
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          const result = yield* (yield* ThreadStore).share(
            test.creator.id,
            test.id,
            ShareThreadRequest.cases.People.make({ participants: [test.cy.id] }),
          )
          expect(result.added).toEqual([test.cy.id])
          const state = yield* stored(test)
          expect(state.audits).toEqual([
            expect.objectContaining({
              companyId: test.company.id,
              personId: test.creator.id,
              by: 'person',
              threadId: null,
            }),
          ])
          expect(state.events).toEqual([
            AuditEvent.cases.ThreadShared.make({
              title: 'Initial title',
              audience: 'named people',
            }),
          ])
          yield* payload(notifications, [
            Topic.thread(test.id),
            Topic.person(test.creator.id),
            Topic.company(test.company.id),
            Topic.person(test.ben.id),
            Topic.person(test.cy.id),
          ])
        }),
    )
    it.effect(
      'case8 sharing with a non-Member preserves audience and participants without audit',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'people', [test.ben.id])
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          expect(
            yield* (yield* ThreadStore)
              .share(
                test.creator.id,
                test.id,
                ShareThreadRequest.cases.People.make({ participants: [test.dee.id] }),
              )
              .pipe(Effect.flip),
          ).toEqual(
            new InvalidRequest({
              message: 'A Thread can only be shared with Members of its Company',
            }),
          )
          const state = yield* stored(test)
          expect(state.rows).toEqual([expect.objectContaining({ audience: 'people' })])
          expect(state.participants).toEqual([expect.objectContaining({ personId: test.ben.id })])
          expect(state.audits).toEqual([])
          yield* silent(notifications)
        }),
    )
    /** Named participation grants reading, never the creator's authority to alter sharing. */
    it.effect('case8b share by a non-creator refuses without audit or announcement', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* seed(test, 'people', [test.ben.id])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* (yield* ThreadStore)
            .share(test.ben.id, test.id, ShareThreadRequest.cases.Private.make({}))
            .pipe(Effect.flip),
        ).toEqual(new Forbidden({ message: 'Only its creator can share a Thread' }))
        const saved = yield* stored(test)
        expect(saved.rows).toEqual([expect.objectContaining({ audience: 'people' })])
        expect(saved.participants.map((row) => row.personId)).toEqual([test.ben.id])
        expect(saved.audits).toEqual([])
        yield* silent(notifications)
      }),
    )
    /** A named Person who loses the last share must receive the invalidation that removes it. */
    layer(testLayer)('Clock case 3', (it) => {
      it.effect('case8c People to Private reloads the removed named Person', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'people', [test.ben.id])
          const store = yield* ThreadStore
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(test.actor(test.ben)),
          )
          expect(observation.initial).toHaveLength(1)
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          yield* store.share(test.creator.id, test.id, ShareThreadRequest.cases.Private.make({}))
          yield* payload(notifications, [
            Topic.thread(test.id),
            Topic.person(test.creator.id),
            Topic.company(test.company.id),
            Topic.person(test.ben.id),
          ])
          expect(yield* nextValue(observation)).toEqual([])
        }),
      )
    })
    layer(testLayer)('Clock case 4', (it) => {
      it.effect('case9 remove announces the deleted audience and reloads its lists', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test, 'people', [test.ben.id])
          const store = yield* ThreadStore
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(test.actor(test.ben)),
          )
          expect(observation.initial).toHaveLength(1)
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          yield* store.remove(test.creator.id, test.id)
          expect((yield* stored(test)).rows).toEqual([])
          yield* payload(notifications, [
            Topic.thread(test.id),
            Topic.person(test.creator.id),
            Topic.company(test.company.id),
            Topic.person(test.ben.id),
          ])
          expect(yield* nextValue(observation)).toEqual([])
        }),
      )
    })
    it.effect('case10 only the creator may remove a visible Thread', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* seed(test, 'people', [test.ben.id])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(yield* (yield* ThreadStore).remove(test.ben.id, test.id).pipe(Effect.flip)).toEqual(
          new Forbidden({ message: 'Only its creator can delete a Thread' }),
        )
        expect((yield* stored(test)).rows).toHaveLength(1)
        yield* silent(notifications)
      }),
    )
    it.effect('case11 markRead announces only its Person and refuses a non-Member', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* seed(test, 'people', [test.ben.id])
        const store = yield* ThreadStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* store.markRead(test.ben.id, test.id)
        yield* payload(notifications, [Topic.part('activity')(Topic.person(test.ben.id))])
        expect(yield* store.markRead(test.dee.id, test.id).pipe(Effect.flip)).toEqual(
          new NotFound({ message: 'Thread not found' }),
        )
        const database = yield* Database
        const reads = yield* database.run(
          database.select().from(threadReads).where(eq(threadReads.threadId, test.id)),
        )
        expect(reads).toEqual([expect.objectContaining({ personId: test.ben.id })])
        yield* silent(notifications)
      }),
    )
    it.effect('case12 generatedTitle announces the current Company audience', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* seed(test, 'company', [])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* (yield* ThreadStore).generatedTitle(test.id, 'Generated', Option.none()),
        ).toBe(true)
        yield* payload(notifications, [
          Topic.thread(test.id),
          Topic.person(test.creator.id),
          Topic.company(test.company.id),
        ])
        expect(
          yield* (yield* ThreadStore).generatedTitle(
            test.id,
            'Discarded',
            Option.some('Superseded'),
          ),
        ).toBe(false)
        expect((yield* stored(test)).rows).toEqual([
          expect.objectContaining({ title: 'Generated' }),
        ])
        yield* silent(notifications)
      }),
    )
    it.effect('case14 ensure announces creation only and refuses another owner', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ThreadStore
        const input = {
          id: test.id,
          title: 'Ensured',
          titleSource: 'Assigned' as const,
          personId: test.creator.id,
          companyId: null,
        }
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const first = yield* store.ensure(input)
        yield* payload(notifications, [Topic.thread(test.id), Topic.person(test.creator.id)])
        expect(yield* store.ensure(input)).toEqual(first)
        yield* silent(notifications)
        expect(yield* store.ensure({ ...input, personId: test.ben.id }).pipe(Effect.flip)).toEqual(
          new DatabaseConstraintViolation({ message: 'Database constraint was violated' }),
        )
        yield* silent(notifications)
      }),
    )
    it.effect('announces Company Project counts for private create, moves and deletion', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const store = yield* ThreadStore
        const projectId = ProjectId.make(crypto.randomUUID())
        yield* database.run(
          database.insert(projectTable).values({
            id: projectId,
            name: 'Project',
            companyId: test.company.id,
            createdBy: test.creator.id,
          }),
        )
        const expected = [
          Topic.thread(test.id),
          Topic.person(test.creator.id),
          Topic.company(test.company.id),
        ]
        const projects = yield* ProjectStore
        const counts = () =>
          projects
            .list(test.actor(test.ben))
            .pipe(
              Effect.map((rows) =>
                rows.map((project) => ({ id: project.id, count: project.threadCount })),
              ),
            )
        expect(yield* counts()).toEqual([{ id: projectId, count: 0 }])
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* store.create(test.actor(test.creator), {
          id: test.id,
          title: 'Filed private Thread',
          projectId,
        })
        yield* payload(notifications, expected)
        expect(yield* counts()).toEqual([{ id: projectId, count: 1 }])
        yield* store.patch(test.creator.id, test.id, { projectId: null })
        yield* payload(notifications, expected)
        expect(yield* counts()).toEqual([{ id: projectId, count: 0 }])
        yield* store.patch(test.creator.id, test.id, { projectId })
        yield* payload(notifications, expected)
        expect(yield* counts()).toEqual([{ id: projectId, count: 1 }])
        yield* store.remove(test.creator.id, test.id)
        yield* payload(notifications, expected)
        expect(yield* counts()).toEqual([{ id: projectId, count: 0 }])
        expect((yield* stored(test)).rows).toEqual([])
      }),
    )
  })
})
