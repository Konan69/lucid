import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { NotificationId, Person, PersonId, SessionId, Workspace } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Option, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { fixture } from '../approvals/testing.ts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { notificationHandlers } from './handlers.ts'
import { NotificationStore, notificationStoreLayer } from './store.ts'
import { notifications } from './tables.ts'

const testLayer = Layer.merge(notificationStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const at = 1_800_000_000_000

/** Handler calls receive the same signed-in recipient/workspace authority as RPC middleware. */
const signedIn = (actor: Actor) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: actor.person,
      workspace: actor.workspace,
      sessionId: SessionId.make('announcement-test'),
    }),
  )

/** Seed directly before LISTEN so neither Notifier nor Push can supply the tested receipt. */
const seed = Effect.fn('NotificationAnnouncements.seed')(function* (
  actor: Actor,
  readAt: number | null,
) {
  const database = yield* Database
  const id = NotificationId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(notifications).values({
      id,
      personId: actor.person.id,
      companyId: companyColumnOf(actor.workspace),
      kind: 'needs-you',
      title: 'Review the report',
      body: 'A decision is waiting.',
      conversationId: null,
      createdAt: at - 1_000,
      readAt,
    }),
  )
  return id
})

/**
 * Brands do not bound length or characters: 1376 raw bytes escape to an 8082-byte topic array.
 * PostgreSQL stores the real Person and indexed notice; only the escaped topic is too large.
 * This fixture is not a production identity pattern; no contract or SDK is widened or patched.
 */
const unannounceableRecipient = Effect.fn('NotificationAnnouncements.unannounceableRecipient')(
  function* () {
    const database = yield* Database
    const person = new Person({
      id: PersonId.make(`${crypto.randomUUID()}${'\u0001'.repeat(1_340)}`),
      name: 'Ada',
      email: `${crypto.randomUUID()}@announce.test`,
      image: null,
    })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          database.run(database.delete(personTable).where(eq(personTable.id, person.id))),
        )
        expect(Result.isSuccess(result)).toBe(true)
      }),
    )
    yield* database.run(
      database
        .insert(personTable)
        .values({ id: person.id, name: person.name, email: person.email }),
    )
    const people = yield* database.run(
      database
        .select({ name: personTable.name })
        .from(personTable)
        .where(eq(personTable.id, person.id)),
    )
    expect(people).toEqual([{ name: 'Ada' }])
    const actor: Actor = {
      person,
      workspace: Workspace.cases.Personal.make({}),
      by: 'person',
      threadId: Option.none(),
    }
    const id = yield* seed(actor, null)
    expect((yield* (yield* NotificationStore).list(actor)).notifications).toMatchObject([
      { id, readAt: null },
    ])
    expect(yield* (yield* NotificationStore).unreadCount(actor)).toBe(1)
    return { actor, id }
  },
)

describe.skipIf(!testDatabaseConfigured)('notification read transaction announcements', () => {
  layer(testLayer)('isolated clock 1', (it) => {
    it.effect('N1 a selected read returns its transaction count and refreshes the recipient', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const one = yield* seed(test.personal, null)
        const two = yield* seed(test.personal, null)
        const store = yield* NotificationStore
        yield* TestClock.setTime(at)
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing(
          [Topic.person(test.personal.person.id)],
          store.list(test.personal),
        )
        expect(observation.initial.unreadCount).toBe(2)
        expect(yield* store.read(test.personal, { ids: [one] })).toEqual({
          changed: 1,
          unreadCount: 1,
        })
        yield* payload(notices, [
          Topic.part('notifications')(Topic.person(test.personal.person.id)),
        ])
        const next = yield* nextValue(observation)
        expect(next.unreadCount).toBe(1)
        expect(next.notifications.find((notice) => notice.id === one)).toMatchObject({ readAt: at })
        expect(next.notifications.find((notice) => notice.id === two)).toMatchObject({
          readAt: null,
        })
      }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)((it) => {
    it.effect(
      'N2 Company read-all announces only its recipient and preserves personal unread rows',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test.member, null)
          yield* seed(test.member, null)
          const personal = yield* seed(test.personal, null)
          const store = yield* NotificationStore
          const notices = yield* (yield* PgClient).listen(CHANNEL)
          expect(yield* store.read(test.member, {})).toEqual({ changed: 2, unreadCount: 0 })
          yield* payload(notices, [
            Topic.part('notifications')(Topic.person(test.member.person.id)),
          ])
          const remaining = yield* store.list(test.personal)
          expect(remaining.unreadCount).toBe(1)
          expect(remaining.notifications).toMatchObject([{ id: personal, readAt: null }])
        }).pipe(Effect.scoped),
    )

    it.effect(
      'N3 empty, already-read, foreign and repeated reads are silent with true counts',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* seed(test.personal, null)
          const alreadyRead = yield* seed(test.personal, at - 500)
          const foreign = yield* seed(test.other, null)
          const store = yield* NotificationStore
          const notices = yield* (yield* PgClient).listen(CHANNEL)
          for (const ids of [[], [alreadyRead], [foreign]]) {
            expect(yield* store.read(test.personal, { ids })).toEqual({
              changed: 0,
              unreadCount: 1,
            })
            yield* silent(notices)
          }
          expect((yield* store.list(test.other)).notifications).toMatchObject([
            { id: foreign, readAt: null },
          ])
          expect(yield* store.read(test.personal, {})).toEqual({ changed: 1, unreadCount: 0 })
          yield* payload(notices, [
            Topic.part('notifications')(Topic.person(test.personal.person.id)),
          ])
          expect(yield* store.read(test.personal, {})).toEqual({ changed: 0, unreadCount: 0 })
          yield* silent(notices)
        }).pipe(Effect.scoped),
    )

    it.effect('Company handler no-ops stay silent and changes announce only the recipient', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const one = yield* seed(test.member, null)
        yield* seed(test.member, null)
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const alreadyRead = yield* seed(test.member, at - 500)
        expect(
          yield* notificationHandlers
            .ReadNotifications({ ids: [alreadyRead] })
            .pipe(signedIn(test.member)),
        ).toEqual({ changed: 0, unreadCount: 2 })
        yield* silent(notices)
        expect(
          yield* notificationHandlers.ReadNotifications({ ids: [one] }).pipe(signedIn(test.member)),
        ).toEqual({ changed: 1, unreadCount: 1 })
        yield* payload(notices, [Topic.part('notifications')(Topic.person(test.member.person.id))])
      }).pipe(Effect.scoped),
    )
  })
  layer(testLayer)('isolated clock 6', (it) => {
    it.effect('NF a real payload rejection rolls back readAt and stays silent', () =>
      Effect.gen(function* () {
        const { actor, id } = yield* unannounceableRecipient()
        const database = yield* Database
        const store = yield* NotificationStore
        yield* TestClock.setTime(at)
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const result = yield* Effect.result(store.read(actor, {}))
        const rows = yield* database.run(
          database
            .select({ readAt: notifications.readAt })
            .from(notifications)
            .where(eq(notifications.id, id)),
        )
        // A successful result, readAt or lowered count here would show that the read escaped rollback.
        expect({
          result: Result.match(result, {
            onSuccess: (reply) => ({ outcome: 'Success', reply }),
            onFailure: (error) => ({ outcome: error._tag, message: error.message }),
          }),
          rows,
          unreadCount: yield* store.unreadCount(actor),
        }).toEqual({
          result: {
            outcome: 'DatabaseFailure',
            message: 'Change notification exceeds its payload limit',
          },
          rows: [{ readAt: null }],
          unreadCount: 1,
        })
        yield* silent(notices)
      }).pipe(Effect.scoped),
    )
  })
})
