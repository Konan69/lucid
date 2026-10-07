import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  Company,
  CompanyId,
  Notification,
  NotificationId,
  Person,
  PersonId,
  ShareThreadRequest,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Option, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { threadParticipants, threads } from '../threads/tables.ts'
import { NotificationStore, notificationStoreLayer } from './store.ts'
import { notifications } from './tables.ts'

const testLayer = Layer.merge(notificationStoreLayer, [threadStoreLayer, changesLayer]).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const at = 1_800_000_000_000

/** Isolated real rows are cleaned through their owners; register finalization before any insert. */
const fixture = Effect.fn('NotificationPrivacy.fixture')(function* () {
  const database = yield* Database
  const people = ['Creator', 'Ben', 'Cy', 'Dee'].map((name) =>
    Person.make({
      id: PersonId.make(crypto.randomUUID()),
      name,
      email: `${crypto.randomUUID()}@privacy.test`,
      image: null,
    }),
  )
  const [creator, ben, cy, dee] = people
  if (creator === undefined || ben === undefined || cy === undefined || dee === undefined)
    return yield* Effect.sync(() => expect.fail('Fixture People missing'))
  const company = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Privacy Company',
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
  /** Owner role is deliberately present; no administrative role widens private Thread reach. */
  const actor = (person: Person): Actor => ({
    person,
    workspace: Workspace.cases.Company.make({
      company,
      role: person.id === ben.id ? 'owner' : 'member',
    }),
    by: 'person',
    threadId: Option.none(),
  })
  /** Invitations live in personal space even when this Person also belongs to a Company. */
  const personal = (person: Person): Actor => ({
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  })
  return { creator, ben, cy, dee, company, actor, personal }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Seed before observing so only the tested share/remove/read supplies notification receipts. */
const seedThread = Effect.fn('NotificationPrivacy.seedThread')(function* (
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
      title: 'Private work title',
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

/** Use real producer shapes without Notifier or Push obscuring the reader seam under test. */
const seedNotice = Effect.fn('NotificationPrivacy.seedNotice')(function* (
  actor: Actor,
  threadId: ThreadId | null,
  kind: Notification['kind'],
  createdAt: number,
) {
  const database = yield* Database
  const id = NotificationId.make(crypto.randomUUID())
  const notice = Notification.make({
    id,
    kind,
    title: `Notice ${id}`,
    body: `Private work excerpt ${id}`,
    threadId,
    createdAt,
    readAt: null,
  })
  yield* database.run(
    database.insert(notifications).values({
      id,
      personId: actor.person.id,
      companyId: companyColumnOf(actor.workspace),
      kind,
      title: notice.title,
      body: notice.body,
      conversationId: threadId,
      createdAt,
      readAt: null,
    }),
  )
  return notice
})

/** Both public count forms agree with the page, whose full equality also excludes hidden excerpts. */
const shown = Effect.fn('NotificationPrivacy.shown')(function* (
  actor: Actor,
  expected: ReadonlyArray<Notification>,
  unreadCount: number,
) {
  const store = yield* NotificationStore
  expect(yield* store.list(actor)).toEqual({ notifications: expected, unreadCount })
  expect(yield* store.unreadCount(actor)).toBe(unreadCount)
})

/** P1-P10 cross real PostgreSQL, production stores and the existing LISTEN/watch signals. */
describe.skipIf(!testDatabaseConfigured)('Notification Thread privacy', () => {
  layer(testLayer)((it) => {
    it.effect(
      'P1 making a named Thread private removes its notices from a live page and count',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const actor = test.actor(test.ben)
          const id = yield* seedThread(test, 'people', test.company.id, [test.ben.id])
          const shared = yield* seedNotice(actor, id, 'shared', 1)
          const finished = yield* seedNotice(actor, id, 'finished', 2)
          const unrelated = yield* seedNotice(actor, null, 'finished', 3)
          const store = yield* NotificationStore
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(actor),
          )
          expect(observation.initial).toEqual({
            notifications: [unrelated, finished, shared],
            unreadCount: 3,
          })
          yield* (yield* ThreadStore).share(
            test.creator.id,
            id,
            ShareThreadRequest.cases.Private.make({}),
          )
          // A missing filter leaves the watch result unchanged; fail on leaked data before waiting.
          yield* shown(actor, [unrelated], 1)
          expect(yield* nextValue(observation)).toEqual({
            notifications: [unrelated],
            unreadCount: 1,
          })
        }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 2', (it) => {
    it.effect(
      'P2 hidden selected reads are silent and mark-all announces only its visible change',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const actor = test.actor(test.ben)
          const id = yield* seedThread(test, 'people', test.company.id, [test.ben.id])
          const shared = yield* seedNotice(actor, id, 'shared', 1)
          yield* seedNotice(actor, id, 'finished', 2)
          const unrelated = yield* seedNotice(actor, null, 'finished', 3)
          yield* (yield* ThreadStore).share(
            test.creator.id,
            id,
            ShareThreadRequest.cases.Private.make({}),
          )
          const store = yield* NotificationStore
          yield* TestClock.setTime(at)
          const receipts = yield* (yield* PgClient).listen(CHANNEL)
          expect(yield* store.read(actor, { ids: [shared.id] })).toEqual({
            changed: 0,
            unreadCount: 1,
          })
          yield* silent(receipts)
          expect(yield* store.read(actor, {})).toEqual({ changed: 1, unreadCount: 0 })
          yield* payload(receipts, [Topic.person(test.ben.id)])
          yield* shown(actor, [Notification.make({ ...unrelated, readAt: at })], 0)
        }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 3', (it) => {
    it.effect(
      'P3 re-sharing returns hidden notices unread after selective and mark-all reads',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const actor = test.actor(test.ben)
          const id = yield* seedThread(test, 'people', test.company.id, [test.ben.id])
          const shared = yield* seedNotice(actor, id, 'shared', 1)
          const finished = yield* seedNotice(actor, id, 'finished', 2)
          const unrelated = yield* seedNotice(actor, null, 'finished', 3)
          const threadStore = yield* ThreadStore
          const store = yield* NotificationStore
          yield* TestClock.setTime(at)
          yield* threadStore.share(test.creator.id, id, ShareThreadRequest.cases.Private.make({}))
          yield* store.read(actor, { ids: [shared.id] })
          yield* store.read(actor, {})
          const observation = yield* observing(
            [Topic.person(test.ben.id), Topic.company(test.company.id)],
            store.list(actor),
          )
          yield* threadStore.share(
            test.creator.id,
            id,
            ShareThreadRequest.cases.People.make({ participants: [test.ben.id] }),
          )
          const expected = [Notification.make({ ...unrelated, readAt: at }), finished, shared]
          // Baseline marking consumes hidden notices; assert unread restoration before awaiting watch.
          yield* shown(actor, expected, 2)
          expect(yield* nextValue(observation)).toEqual({ notifications: expected, unreadCount: 2 })
        }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)((it) => {
    it.effect('P4 deleting a Thread conceals its notices from recipient and creator', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor = test.actor(test.ben)
        const creator = test.actor(test.creator)
        const id = yield* seedThread(test, 'people', test.company.id, [test.ben.id])
        const finished = yield* seedNotice(actor, id, 'finished', 1)
        const own = yield* seedNotice(creator, id, 'finished', 2)
        const unrelated = yield* seedNotice(actor, null, 'finished', 3)
        yield* shown(actor, [unrelated, finished], 2)
        yield* shown(creator, [own], 1)
        yield* (yield* ThreadStore).remove(test.creator.id, id)
        yield* shown(actor, [unrelated], 1)
        yield* shown(creator, [], 0)
        expect(yield* (yield* NotificationStore).read(creator, { ids: [own.id] })).toEqual({
          changed: 0,
          unreadCount: 0,
        })
      }).pipe(Effect.scoped),
    )

    it.effect('P5 narrowing Company reach keeps only the named recipient notices', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const ben = test.actor(test.ben)
        const cy = test.actor(test.cy)
        const id = yield* seedThread(test, 'company', test.company.id, [])
        const benNotice = yield* seedNotice(ben, id, 'needs-you', 1)
        const cyNotice = yield* seedNotice(cy, id, 'needs-you', 2)
        yield* shown(cy, [cyNotice], 1)
        yield* (yield* ThreadStore).share(
          test.creator.id,
          id,
          ShareThreadRequest.cases.People.make({ participants: [test.ben.id] }),
        )
        yield* shown(cy, [], 0)
        yield* shown(ben, [benNotice], 1)
      }).pipe(Effect.scoped),
    )

    it.effect('P6 hidden newer notices cannot consume the page limit', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor = test.actor(test.ben)
        const id = yield* seedThread(test, 'private', test.company.id, [])
        const older = yield* Effect.forEach([1, 2, 3], (createdAt) =>
          seedNotice(actor, null, 'finished', createdAt),
        )
        for (let index = 0; index < 60; index += 1)
          yield* seedNotice(actor, id, 'finished', 100 + index)
        yield* shown(actor, older.toReversed(), 3)
      }).pipe(Effect.scoped),
    )

    it.effect('P7 an owner role cannot read or mark another Member private Thread notice', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor = test.actor(test.ben)
        const id = yield* seedThread(test, 'private', test.company.id, [])
        const notice = yield* seedNotice(actor, id, 'finished', 1)
        yield* shown(actor, [], 0)
        expect(yield* (yield* NotificationStore).read(actor, { ids: [notice.id] })).toEqual({
          changed: 0,
          unreadCount: 0,
        })
      }).pipe(Effect.scoped),
    )

    it.effect('P8 personal Thread deletion keeps a Thread-free invitation visible', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor = test.personal(test.creator)
        const id = yield* seedThread(test, 'private', null, [])
        const finished = yield* seedNotice(actor, id, 'finished', 1)
        const invited = yield* seedNotice(actor, null, 'invited', 2)
        yield* shown(actor, [invited, finished], 2)
        yield* (yield* ThreadStore).remove(test.creator.id, id)
        yield* shown(actor, [invited], 1)
      }).pipe(Effect.scoped),
    )

    it.effect('P9 Company notices stay out of personal and other Company workspaces', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor = test.actor(test.ben)
        const id = yield* seedThread(test, 'company', test.company.id, [])
        const notice = yield* seedNotice(actor, id, 'finished', 1)
        yield* shown(actor, [notice], 1)
        yield* shown(test.personal(test.ben), [], 0)
        const database = yield* Database
        const company = Company.make({
          id: CompanyId.make(crypto.randomUUID()),
          name: 'Other Company',
          slug: crypto.randomUUID(),
        })
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const cleanup = yield* Effect.result(
              database.run(database.delete(companyTable).where(eq(companyTable.id, company.id))),
            )
            expect(Result.isSuccess(cleanup)).toBe(true)
          }),
        )
        yield* database.run(database.insert(companyTable).values(company))
        yield* database.run(
          database.insert(membershipTable).values({
            id: crypto.randomUUID(),
            companyId: company.id,
            userId: test.ben.id,
            role: 'owner',
          }),
        )
        const elsewhere: Actor = {
          person: test.ben,
          workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
          by: 'person',
          threadId: Option.none(),
        }
        yield* shown(elsewhere, [], 0)
        expect(yield* (yield* NotificationStore).read(elsewhere, { ids: [notice.id] })).toEqual({
          changed: 0,
          unreadCount: 0,
        })
      }).pipe(Effect.scoped),
    )

    it.effect(
      'P10 corrupt Thread audiences hide notices from creator and other Members without failing',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const id = yield* seedThread(test, 'everyone', test.company.id, [])
          const store = yield* NotificationStore
          for (const person of [test.creator, test.cy]) {
            const actor = test.actor(person)
            const notice = yield* seedNotice(actor, id, 'finished', 1)
            const unrelated = yield* seedNotice(actor, null, 'finished', 2)
            yield* shown(actor, [unrelated], 1)
            expect(yield* store.read(actor, { ids: [notice.id] })).toEqual({
              changed: 0,
              unreadCount: 1,
            })
          }
        }).pipe(Effect.scoped),
    )
  })
})
