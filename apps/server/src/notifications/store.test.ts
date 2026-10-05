import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Option, Stream } from 'effect'
import { Person, PersonId, Workspace } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes } from '../live/changes.ts'
import { settingsTable } from '../settings/tables.ts'
import { Notifier, notifierLayer } from './notifier.ts'
import { silentPushLayer } from '../push/testing.ts'
import { NotificationStore, notificationStoreLayer } from './store.ts'

/** PostgreSQL remains the seam under test; publication has no clients in this fixture. */
const testLayer = Layer.mergeAll(notifierLayer, notificationStoreLayer).pipe(
  Layer.provide(silentPushLayer),
  Layer.provideMerge(testDatabaseLayer),
  Layer.provide(
    Layer.succeed(
      Changes,
      Changes.of({
        publish: () => Effect.void,
        subscribe: () => Effect.succeed(Stream.empty),
      }),
    ),
  ),
)

/** Each recipient has its own real Person and personal workspace. */
const actor = (name: string): Actor => ({
  person: new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name,
    email: `${NodeCrypto.randomUUID()}@notices.test`,
    image: null,
  }),
  workspace: Workspace.cases.Personal.make({}),
  by: 'person',
  threadId: Option.none(),
})

/** Fresh People isolate notices and settings; cleanup is registered before the first write. */
const fixture = Effect.fn('NotificationsTest.fixture')(function* () {
  const database = yield* Database
  const owner = actor('Ada')
  const other = actor('Ben')
  const people = [owner.person, other.person]
  yield* Effect.addFinalizer(() =>
    database
      .run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((person) => person.id),
          ),
        ),
      )
      .pipe(
        Effect.tapError((error) => Effect.logError('Notification fixture cleanup failed', error)),
        Effect.ignore,
      ),
  )
  for (const person of people)
    yield* database.run(
      database.insert(personTable).values({
        id: person.id,
        name: person.name,
        email: person.email,
        emailVerified: true,
      }),
    )
  return { database, owner, other }
})

describe.skipIf(!testDatabaseConfigured)('recipient notifications', () => {
  layer(testLayer)((it) => {
    it.effect('suppresses opted-out notices and conceals other recipients from list and read', () =>
      Effect.gen(function* () {
        const { database, owner, other } = yield* fixture()
        const notifier = yield* Notifier
        const store = yield* NotificationStore
        yield* database.run(
          database.insert(settingsTable).values({ personId: owner.person.id, notify: false }),
        )
        const notice = {
          personId: owner.person.id,
          companyId: null,
          kind: 'needs-you' as const,
          title: 'Review the report',
          body: 'A decision is waiting.',
          threadId: null,
        }
        yield* notifier.notify(notice)
        expect((yield* store.list(owner)).notifications).toEqual([])
        yield* database.run(
          database
            .update(settingsTable)
            .set({ notify: true })
            .where(eq(settingsTable.personId, owner.person.id)),
        )
        yield* notifier.notify(notice)
        const own = yield* store.list(owner)
        expect(own.unreadCount).toBe(1)
        expect(own.notifications[0]).toMatchObject({ kind: 'needs-you', title: notice.title })
        expect((yield* store.list(other)).notifications).toEqual([])
        expect(yield* store.read(other, { ids: own.notifications.map((item) => item.id) })).toEqual(
          {
            changed: 0,
            unreadCount: 0,
          },
        )
        expect(yield* store.read(owner, { ids: [] })).toEqual({ changed: 0, unreadCount: 1 })
        expect(yield* store.read(owner, {})).toEqual({ changed: 1, unreadCount: 0 })
        expect(yield* store.read(owner, {})).toEqual({ changed: 0, unreadCount: 0 })
        expect(yield* store.unreadCount(owner)).toBe(0)
      }),
    )
  })
})
