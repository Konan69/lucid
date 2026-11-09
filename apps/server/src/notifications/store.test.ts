import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { inArray } from 'drizzle-orm'
import { Effect, Layer, Option, Ref, Result, Stream } from 'effect'
import { Person, PersonId, PushOutcome, Workspace } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { workLayer } from '../database/work.ts'
import { PushTargets, pushTargetsLayer } from '../push/targets.ts'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { Notifier, notifierLayer } from './notifier.ts'
import { Push } from '../push/delivery.ts'
import { silentPushLayer } from '../push/testing.ts'
import { NotificationStore, notificationStoreLayer } from './store.ts'

/** PostgreSQL remains the seam under test; publication has no clients in this fixture. */
const testLayer = Layer.mergeAll(notifierLayer, notificationStoreLayer).pipe(
  Layer.provideMerge(pushTargetsLayer),
  Layer.provideMerge(workLayer),
  Layer.provideMerge(testDatabaseLayer),
  Layer.provide(silentPushLayer),
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
  helper: Option.none(),
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
        Effect.result,
        Effect.map((result) => expect(Result.isSuccess(result)).toBe(true)),
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
  const published = yield* Ref.make<ReadonlyArray<ReadonlyArray<Topic>>>([])
  const pushed = yield* Ref.make<ReadonlyArray<Parameters<Push['Service']['deliver']>>>([])
  const recorded = notifierLayer.pipe(
    Layer.provide([
      Layer.succeed(Database, database),
      Layer.succeed(
        PersistedQueue.PersistedQueueFactory,
        yield* PersistedQueue.PersistedQueueFactory,
      ),
      Layer.succeed(PushTargets, yield* PushTargets),
      Layer.mock(Changes, {
        publish: (topics) => Ref.update(published, (receipts) => [...receipts, topics]),
      }),
      Layer.mock(Push, {
        deliver: (...input) =>
          Ref.update(pushed, (receipts) => [...receipts, input]).pipe(
            Effect.as(PushOutcome.cases.NoTargets.make({})),
          ),
      }),
    ]),
  )
  const context = yield* Layer.build(Layer.fresh(recorded))
  const notifier = yield* Notifier.pipe(Effect.provideContext(context))
  return { database, owner, other, notifier, published, pushed }
})

describe.skipIf(!testDatabaseConfigured)('recipient notifications', () => {
  layer(testLayer)((it) => {
    it.effect('conceals other recipients from list and read', () =>
      Effect.gen(function* () {
        const { owner, other, notifier, published, pushed } = yield* fixture()
        const store = yield* NotificationStore
        const notice = {
          personId: owner.person.id,
          companyId: null,
          kind: 'needs-you' as const,
          title: 'Review the report',
          body: 'A decision is waiting.',
          threadId: null,
          approvalId: null,
        }
        yield* notifier.notify(notice)
        const own = yield* store.list(owner)
        expect(own.unreadCount).toBe(1)
        const [stored] = own.notifications
        if (stored === undefined) expect.fail('Expected the visible notice')
        // Delivery is owed in SQL; this producer does not contact a device before commit.
        expect(yield* Ref.get(published)).toEqual([])
        expect(yield* Ref.get(pushed)).toEqual([])
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
