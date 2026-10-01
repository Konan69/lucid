import * as NodeCrypto from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from 'effect'
import {
  Assignee,
  AssigneeInput,
  Author,
  FollowUpId,
  RuntimeUnavailable,
  TaskId,
  NotFound,
  Company,
  CompanyId,
  Person,
  PersonId,
  Run,
  RunId,
  RunOrigin,
  RunState,
  Workspace,
} from '@vivid/contracts'
import { loadSummaries, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Notifier, notifierLayer } from '../notifications/notifier.ts'
import { NotificationStore, notificationStoreLayer } from '../notifications/store.ts'
import { settingsTable } from '../settings/tables.ts'
import { Conversation, StoredRunOrigin, type Delivery } from '../threads/conversation.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threadParticipants, threads } from '../threads/tables.ts'
import { FollowUps, followUpsLayer } from './followups.ts'
import { TaskStore, taskStoreLayer } from './store.ts'
import { notifications, tasks } from './tables.ts'

class Receipts extends Context.Service<Receipts, Ref.Ref<ReadonlyArray<Delivery>>>()(
  'tasks/test/Receipts',
) {}
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<Topic>>>()(
  'tasks/test/Published',
) {}

/** Records the product delivery seam, while all Task and notification persistence uses real PostgreSQL. */
const conversationLayer = Layer.effectContext(
  Effect.gen(function* () {
    const receipts = yield* Ref.make<ReadonlyArray<Delivery>>([])
    const database = yield* Database
    const deliver = Effect.fn('Conversation.test.deliver')(function* (delivery: Delivery) {
      yield* Ref.update(receipts, (values) => [...values, delivery])
      const people = yield* loadSummaries([delivery.personId]).pipe(
        Effect.provideService(Database, database),
      )
      const person = people.get(delivery.personId)
      if (person === undefined)
        return yield* Effect.fail(new NotFound({ message: 'Test Person not found' }))
      const origin = StoredRunOrigin.match(delivery.origin, {
        Message: (): RunOrigin => RunOrigin.cases.Message.make({ person }),
        Routine: ({ routineName }): RunOrigin =>
          RunOrigin.cases.Routine.make({ person, routineName }),
        FollowUp: ({ taskTitle }): RunOrigin =>
          RunOrigin.cases.FollowUp.make({ person, taskTitle }),
        Decision: (): RunOrigin => RunOrigin.cases.Decision.make({ person }),
      })
      return Run.make({
        id: RunId.make(NodeCrypto.randomUUID()),
        threadId: delivery.threadId,
        origin,
        state: RunState.cases.Working.make({}),
        startedAt: yield* Clock.currentTimeMillis,
      })
    })
    return Context.make(
      Conversation,
      Conversation.of({
        deliver,
        admit: Effect.fn('Conversation.test.admit')(function* (delivery: Delivery) {
          const run = yield* deliver(delivery)
          return { runId: run.id, offset: '0', incarnation: 'test' }
        }),
      }),
    ).pipe(Context.add(Receipts, receipts))
  }),
)

/** Publication is observed independently of LISTEN/NOTIFY timing; no scheduler sleeps are involved. */
const changesLayer = Layer.effectContext(
  Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<Topic>>([])
    return Context.make(
      Changes,
      Changes.of({
        publish: (topics) => Ref.update(published, (values) => [...values, ...topics]),
        subscribe: () => Effect.succeed(Stream.never),
      }),
    ).pipe(Context.add(Published, published))
  }),
)

const foundation = Layer.merge(testDatabaseLayer, changesLayer)
const dependencies = Layer.mergeAll(
  notifierLayer,
  notificationStoreLayer,
  threadStoreLayer,
  conversationLayer,
).pipe(Layer.provideMerge(foundation))
const stores = taskStoreLayer.pipe(Layer.provideMerge(dependencies))
const testLayer = followUpsLayer.pipe(Layer.provideMerge(stores))

/** Unique fixtures register cleanup before any write; only the disposable database may supply this Layer. */
const fixture = Effect.fn('Tasks.test.fixture')(function* () {
  const database = yield* Database
  const person = Person.make({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Creator',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const member = Person.make({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Member',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const outsider = Person.make({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Outsider',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const company = Company.make({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Test Company',
    slug: NodeCrypto.randomUUID(),
  })
  const ids = [person.id, member.id, outsider.id]
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(
        database.delete(notifications).where(inArray(notifications.personId, ids)),
      )
      yield* database.run(database.delete(tasks).where(inArray(tasks.personId, ids)))
      yield* database.run(database.delete(threads).where(inArray(threads.personId, ids)))
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(database.delete(personTable).where(inArray(personTable.id, ids)))
    }).pipe(Effect.catch((error) => Effect.logError('Task fixture cleanup failed', error._tag))),
  )
  yield* database.run(
    database.insert(personTable).values(
      [person, member, outsider].map((value) => ({
        id: value.id,
        name: value.name,
        email: value.email,
      })),
    ),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: NodeCrypto.randomUUID(), companyId: company.id, userId: person.id, role: 'owner' },
      { id: NodeCrypto.randomUUID(), companyId: company.id, userId: member.id, role: 'member' },
    ]),
  )
  const personal: Actor = {
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  const owner: Actor = {
    ...personal,
    workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
  }
  const teammate: Actor = {
    ...owner,
    person: member,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
  }
  const other: Actor = { ...personal, person: outsider }
  return { database, personal, owner, teammate, other, company }
})

describe.skipIf(!testDatabaseConfigured)('workspace Tasks and notifications', () => {
  layer(testLayer)((it) => {
    it.effect('keeps personal Tasks out of Company workspaces and other Persons', () =>
      Effect.gen(function* () {
        const { personal, owner, other } = yield* fixture()
        const store = yield* TaskStore
        const task = yield* store.create(personal, { title: 'Private work' })
        expect((yield* store.list(personal, {})).map((item) => item.id)).toContain(task.id)
        expect((yield* store.list(owner, {})).map((item) => item.id)).not.toContain(task.id)
        expect((yield* store.list(other, {})).map((item) => item.id)).not.toContain(task.id)
        expect((yield* Effect.flip(store.get(other, task.id)))._tag).toBe('NotFound')
        expect((yield* Effect.flip(store.patch(owner, task.id, { title: 'probe' })))._tag).toBe(
          'NotFound',
        )
      }),
    )

    it.effect('grants Company Tasks by Thread audience and participation, never by role', () =>
      Effect.gen(function* () {
        const { database, owner, teammate } = yield* fixture()
        const store = yield* TaskStore
        const task = yield* store.create(owner, { title: 'Private Company work' })
        expect((yield* store.list(teammate, {})).map((item) => item.id)).not.toContain(task.id)
        yield* database.run(
          database.update(threads).set({ audience: 'people' }).where(eq(threads.id, task.threadId)),
        )
        yield* database.run(
          database
            .insert(threadParticipants)
            .values({ threadId: task.threadId, personId: teammate.person.id, addedAt: 0 }),
        )
        expect((yield* store.list(teammate, {})).map((item) => item.id)).toContain(task.id)
        expect((yield* store.patch(teammate, task.id, { title: 'Reviewed' })).title).toBe(
          'Reviewed',
        )
        expect((yield* Effect.flip(store.remove(teammate, task.id)))._tag).toBe('NotFound')
        yield* database.run(
          database.delete(threadParticipants).where(eq(threadParticipants.threadId, task.threadId)),
        )
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'company' })
            .where(eq(threads.id, task.threadId)),
        )
        expect((yield* store.list(teammate, {})).map((item) => item.id)).toContain(task.id)
      }),
    )

    it.effect('rejects non-Members and grants the Member assignee access and deletion', () =>
      Effect.gen(function* () {
        const { owner, teammate, other } = yield* fixture()
        const store = yield* TaskStore
        const invalid = yield* Effect.flip(
          store.create(owner, {
            title: 'Invalid assignment',
            assignee: AssigneeInput.cases.Member.make({ personId: other.person.id }),
          }),
        )
        expect(invalid._tag).toBe('InvalidRequest')
        const task = yield* store.create(owner, {
          title: 'Assigned work',
          assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
        })
        expect(Assignee.guards.Member(task.assignee)).toBe(true)
        expect((yield* store.list(teammate, {})).map((item) => item.id)).toContain(task.id)
        const notices = yield* (yield* NotificationStore).list(teammate)
        expect(
          notices.notifications.some(
            (notice) => notice.taskId === task.id && notice.kind === 'assigned',
          ),
        ).toBe(true)
        const cleared = yield* store.patch(owner, task.id, {
          assignee: AssigneeInput.cases.Nobody.make({}),
        })
        expect(Assignee.guards.Nobody(cleared.assignee)).toBe(true)
        expect((yield* store.list(teammate, {})).map((item) => item.id)).not.toContain(task.id)
        yield* store.patch(owner, task.id, {
          assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
        })
        yield* store.remove(teammate, task.id)
      }),
    )

    it.effect(
      'suppresses opted-out notices and scopes notification reads to the recipient workspace',
      () =>
        Effect.gen(function* () {
          const { database, personal, owner, other } = yield* fixture()
          const notifier = yield* Notifier
          const store = yield* NotificationStore
          yield* database.run(
            database.insert(settingsTable).values({ personId: personal.person.id, notify: false }),
          )
          const notice = {
            personId: personal.person.id,
            companyId: null,
            kind: 'tracked' as const,
            title: 'Suppressed',
            body: '',
            taskId: null,
            threadId: null,
          }
          const published = yield* Published
          yield* Ref.set(published, [])
          yield* notifier.notify(notice)
          expect((yield* store.list(personal)).notifications).toHaveLength(0)
          expect(yield* Ref.get(published)).toHaveLength(0)
          yield* database.run(
            database
              .update(settingsTable)
              .set({ notify: true })
              .where(eq(settingsTable.personId, personal.person.id)),
          )
          yield* notifier.notify(notice)
          const own = yield* store.list(personal)
          expect(own.unreadCount).toBe(1)
          expect((yield* store.list(owner)).notifications).toHaveLength(0)
          expect((yield* store.list(other)).notifications).toHaveLength(0)
          expect(yield* store.read(other, { ids: own.notifications.map((item) => item.id) })).toBe(
            0,
          )
          expect(yield* store.read(owner, {})).toBe(0)
          expect(yield* store.read(personal, {})).toBe(1)
          expect(yield* store.unreadCount(personal)).toBe(0)
        }),
    )

    it.effect(
      'attributes Vivid work to its Person and rejects reporting Threads outside the workspace',
      () =>
        Effect.gen(function* () {
          const { personal, owner, other } = yield* fixture()
          const store = yield* TaskStore
          const parent = yield* store.create(personal, { title: 'Reporting Thread' })
          const vivid: Actor = { ...personal, by: 'vivid', threadId: Option.some(parent.threadId) }
          const task = yield* store.create(vivid, { title: 'Vivid work', followUp: { at: 10 } })
          expect(Author.guards.Vivid(task.createdBy)).toBe(true)
          expect(task.createdBy).toMatchObject({ onBehalfOf: { id: personal.person.id } })
          expect(task.threadId).toBe(parent.threadId)
          expect(task.origin).toEqual({ kind: 'thread', threadId: parent.threadId })
          expect(task.followUps).toHaveLength(1)
          expect(
            Author.guards.Vivid((yield* returned(task.followUps, 'initial follow-up')).createdBy),
          ).toBe(true)
          expect(
            (yield* Effect.flip(
              store.create(owner, { title: 'Wrong workspace', threadId: parent.threadId }),
            ))._tag,
          ).toBe('NotFound')
          expect(
            (yield* Effect.flip(
              store.create(other, { title: 'Wrong Person', threadId: parent.threadId }),
            ))._tag,
          ).toBe('NotFound')
        }),
    )

    it.effect('preserves a Member follow-up author and rejects invisible follow-up mutations', () =>
      Effect.gen(function* () {
        const { owner, teammate, other } = yield* fixture()
        const store = yield* TaskStore
        const task = yield* store.create(owner, {
          title: 'Member follow-up',
          assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
        })
        const followUp = yield* store.addFollowUp(teammate, task.id, { at: 100 })
        expect(followUp.createdBy).toMatchObject({ person: { id: teammate.person.id } })
        expect((yield* Effect.flip(store.getFollowUp(other, followUp.id)))._tag).toBe('NotFound')
        expect(
          (yield* Effect.flip(store.patchFollowUp(other, followUp.id, { note: 'probe' })))._tag,
        ).toBe('NotFound')
        expect((yield* Effect.flip(store.removeFollowUp(other, followUp.id)))._tag).toBe('NotFound')
        expect((yield* Effect.flip((yield* FollowUps).run(other, followUp.id)))._tag).toBe(
          'NotFound',
        )
      }),
    )

    it.effect('rolls back Task insertion when its initial follow-up id collides', () =>
      Effect.gen(function* () {
        const { personal } = yield* fixture()
        const store = yield* TaskStore
        const first = yield* store.create(personal, {
          title: 'Existing schedule',
          followUp: { id: FollowUpId.make(NodeCrypto.randomUUID()), at: 10 },
        })
        const followUp = yield* returned(first.followUps, 'initial follow-up')
        const id = TaskId.make(NodeCrypto.randomUUID())
        expect(
          (yield* Effect.flip(
            store.create(personal, {
              id,
              title: 'Must roll back',
              followUp: { id: followUp.id, at: 20 },
            }),
          ))._tag,
        ).toBe('DatabaseConstraintViolation')
        expect((yield* Effect.flip(store.get(personal, id)))._tag).toBe('NotFound')
        expect(
          (yield* Effect.flip(
            store.create(personal, { id, title: 'Invalid date', followUp: { at: 'not-a-date' } }),
          ))._tag,
        ).toBe('InvalidRequest')
        expect((yield* Effect.flip(store.get(personal, id)))._tag).toBe('NotFound')
      }),
    )

    it.effect(
      'publishes scheduler ownership and stores overdue and failed-delivery notices once',
      () =>
        Effect.gen(function* () {
          const { owner, company } = yield* fixture()
          const store = yield* TaskStore
          const task = yield* store.create(owner, {
            title: 'Overdue work',
            dueAt: 0,
            followUp: { at: 0 },
          })
          const published = yield* Published
          yield* Ref.set(published, [])
          const unavailable = new RuntimeUnavailable({ message: 'Test runtime is unavailable' })
          const conversation = Conversation.of({
            deliver: () => Effect.fail(unavailable),
            admit: () => Effect.fail(unavailable),
          })
          yield* Effect.gen(function* () {
            const service = yield* FollowUps
            yield* service.runDue()
            yield* service.runDue()
          }).pipe(
            Effect.provide(Layer.fresh(followUpsLayer)),
            Effect.provideService(Conversation, conversation),
          )
          const view = yield* store.get(owner, task.id)
          expect(yield* returned(view.followUps, 'failed follow-up')).toMatchObject({
            status: 'failed',
            submissionId: null,
          })
          const notices = yield* (yield* NotificationStore).list(owner)
          expect(
            notices.notifications.filter(
              (notice) => notice.taskId === task.id && notice.kind === 'overdue',
            ),
          ).toHaveLength(1)
          expect(
            notices.notifications.filter(
              (notice) => notice.taskId === task.id && notice.kind === 'follow-up-failed',
            ),
          ).toHaveLength(1)
          const topics = yield* Ref.get(published)
          expect(topics).toContain(Topic.person(owner.person.id))
          expect(topics).toContain(Topic.company(company.id))
        }),
    )

    it.effect(
      'replays caller-chosen Task and follow-up ids without duplicate notices or rows',
      () =>
        Effect.gen(function* () {
          const { personal, other } = yield* fixture()
          const store = yield* TaskStore
          const id = TaskId.make(NodeCrypto.randomUUID())
          const request = {
            id,
            title: 'Replay-safe work',
            followUp: { id: FollowUpId.make(NodeCrypto.randomUUID()), at: 10 },
          }
          const created = yield* Effect.all(
            [store.create(personal, request), store.create(personal, request)],
            { concurrency: 2 },
          )
          const first = yield* returned(created, 'created Task')
          expect(created).toEqual([first, first])
          expect(yield* store.create(personal, request)).toEqual(first)
          expect(
            (yield* (yield* NotificationStore).list(personal)).notifications.filter(
              (notice) => notice.taskId === id && notice.kind === 'tracked',
            ),
          ).toHaveLength(1)
          expect((yield* Effect.flip(store.create(other, request)))._tag).toBe('Conflict')
          const followUpId = FollowUpId.make(NodeCrypto.randomUUID())
          const scheduled = yield* Effect.all(
            [
              store.addFollowUp(personal, id, { id: followUpId, at: 20, note: 'One schedule' }),
              store.addFollowUp(personal, id, { id: followUpId, at: 20, note: 'One schedule' }),
            ],
            { concurrency: 2 },
          )
          const followUp = yield* returned(scheduled, 'created follow-up')
          expect(scheduled).toEqual([followUp, followUp])
          expect(
            yield* store.addFollowUp(personal, id, {
              id: followUpId,
              at: 20,
              note: 'One schedule',
            }),
          ).toEqual(followUp)
          expect(
            (yield* store.get(personal, id)).followUps.filter((item) => item.id === followUpId),
          ).toHaveLength(1)
          const differentTask = yield* store.create(personal, { title: 'Another visible Task' })
          expect(
            yield* store.addFollowUp(personal, differentTask.id, { id: followUpId, at: 30 }),
          ).toEqual(followUp)
          const otherTask = yield* store.create(other, { title: 'Other workspace' })
          expect(
            (yield* Effect.flip(store.addFollowUp(other, otherTask.id, { id: followUpId, at: 30 })))
              ._tag,
          ).toBe('Conflict')
        }),
    )

    it.effect(
      'fires a repeated follow-up and atomically schedules its next occurrence with the same author',
      () =>
        Effect.gen(function* () {
          const { database, owner, teammate } = yield* fixture()
          const store = yield* TaskStore
          const service = yield* FollowUps
          const task = yield* store.create(owner, {
            title: 'Repeated work',
            assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
          })
          yield* database.run(
            database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, task.threadId)),
          )
          const followUp = yield* store.addFollowUp(teammate, task.id, {
            at: 100,
            repeatEveryMs: 500,
            note: 'Keep checking',
          })
          const fired = yield* service.run(teammate, followUp.id)
          expect(fired.status).toBe('fired')
          expect(fired.firedAt).not.toBeNull()
          expect(fired.submissionId).not.toBeNull()
          expect(yield* service.run(teammate, followUp.id)).toEqual(fired)
          const view = yield* store.get(owner, task.id)
          expect(view.followUps).toHaveLength(2)
          const next = yield* returned(
            view.followUps.filter((item) => item.status === 'scheduled'),
            'next follow-up',
          )
          expect(next).toMatchObject({
            at: 600,
            repeatEveryMs: 500,
            note: 'Keep checking',
            createdBy: followUp.createdBy,
            submissionId: null,
            firedAt: null,
          })
        }),
    )

    it.effect(
      'delivers scheduled work as its creator even when another Member wrote the follow-up',
      () =>
        Effect.gen(function* () {
          const { owner, teammate } = yield* fixture()
          const store = yield* TaskStore
          const task = yield* store.create(owner, {
            title: 'Scheduled attribution',
            assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
          })
          const followUp = yield* store.addFollowUp(teammate, task.id, { at: 0 })
          const receipts = yield* Receipts
          yield* Ref.set(receipts, [])
          yield* (yield* FollowUps).runDue()
          const delivery = yield* returned(yield* Ref.get(receipts), 'scheduled delivery')
          expect(delivery.personId).toBe(owner.person.id)
          expect((yield* store.getFollowUp(owner, followUp.id)).status).toBe('fired')
        }),
    )

    it.effect('cancels a claimed follow-up when its Task closes before scheduler delivery', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* TaskStore
        const task = yield* store.create(owner, {
          title: 'Close while claimed',
          followUp: { at: 0 },
        })
        const receipts = yield* Receipts
        yield* Ref.set(receipts, [])
        const claimed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const waiting = yield* Ref.make(true)
        const changes = yield* Changes
        const gated = Changes.of({
          publish: Effect.fn('Tasks.test.pauseClaim')(function* (topics) {
            if (
              topics.includes(Topic.thread(task.threadId)) &&
              (yield* Ref.getAndSet(waiting, false))
            ) {
              yield* Deferred.succeed(claimed, undefined)
              yield* Deferred.await(release)
            }
            yield* changes.publish(topics)
          }),
          subscribe: (topics) => changes.subscribe(topics),
        })
        const worker = yield* Effect.gen(function* () {
          yield* (yield* FollowUps).runDue()
        }).pipe(
          Effect.provide(Layer.fresh(followUpsLayer)),
          Effect.provide(Layer.fresh(taskStoreLayer)),
          Effect.provideService(Changes, gated),
          Effect.forkChild,
        )
        yield* Deferred.await(claimed)
        yield* store.patch(owner, task.id, { status: 'done' })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(worker)
        expect(yield* Ref.get(receipts)).toHaveLength(0)
        const view = yield* store.get(owner, task.id)
        expect(yield* returned(view.followUps, 'cancelled follow-up')).toMatchObject({
          status: 'cancelled',
          submissionId: null,
        })
      }),
    )

    it.effect(
      'batches Task projections without losing Member authors, assignments or empty schedules',
      () =>
        Effect.gen(function* () {
          const { owner, teammate } = yield* fixture()
          const store = yield* TaskStore
          const assigned = yield* store.create(owner, {
            title: 'With a Member',
            assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
          })
          const empty = yield* store.create(owner, { title: 'No schedule' })
          const followUp = yield* store.addFollowUp(teammate, assigned.id, { at: 50 })
          const listed = yield* store.list(owner, {})
          const withSchedule = yield* returned(
            listed.filter((task) => task.id === assigned.id),
            'assigned Task',
          )
          expect(withSchedule.assignee).toMatchObject({ person: { id: teammate.person.id } })
          expect(withSchedule.followUps).toEqual([followUp])
          expect(withSchedule.nextFollowUpAt).toBe(50)
          const without = yield* returned(
            listed.filter((task) => task.id === empty.id),
            'unscheduled Task',
          )
          expect(without.followUps).toHaveLength(0)
          expect(without.nextFollowUpAt).toBeNull()
        }),
    )

    it.effect('claims due follow-ups once and delivers manual work as the clicking Person', () =>
      Effect.gen(function* () {
        const { owner, teammate } = yield* fixture()
        const store = yield* TaskStore
        const service = yield* FollowUps
        const task = yield* store.create(owner, {
          title: 'Chase delivery',
          assignee: AssigneeInput.cases.Member.make({ personId: teammate.person.id }),
        })
        const database = yield* Database
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'company' })
            .where(eq(threads.id, task.threadId)),
        )
        const followUp = yield* store.addFollowUp(owner, task.id, { at: 0 })
        const batches = yield* Effect.all([store.claimDueFollowUps(), store.claimDueFollowUps()], {
          concurrency: 2,
        })
        const first = batches.flat()
        const replay = yield* store.claimDueFollowUps()
        expect(first.map((item) => item.followUp.id)).toContain(followUp.id)
        expect(first.filter((item) => item.followUp.id === followUp.id)).toHaveLength(1)
        expect(replay.map((item) => item.followUp.id)).not.toContain(followUp.id)
        const receipts = yield* Receipts
        yield* Ref.set(receipts, [])
        const result = yield* service.run(teammate, followUp.id)
        yield* service.run(teammate, followUp.id)
        yield* service.nudge(teammate, task.id, { note: 'Check now' })
        const delivered = yield* Ref.get(receipts)
        expect(delivered).toHaveLength(2)
        expect(delivered.map((item) => item.personId)).toEqual([
          teammate.person.id,
          teammate.person.id,
        ])
        expect(delivered.map((item) => item.threadId)).toEqual([task.threadId, task.threadId])
        expect(result.submissionId).not.toBeNull()
        expect(result.status).toBe('fired')
        const notices = yield* (yield* NotificationStore).list(owner)
        expect(
          notices.notifications.filter(
            (notice) => notice.taskId === task.id && notice.kind === 'follow-up',
          ),
        ).toHaveLength(2)
        expect(delivered[0]).toMatchObject({
          message: { type: 'follow-up', attributes: { task: task.id } },
          origin: StoredRunOrigin.cases.FollowUp.make({ taskTitle: task.title }),
        })
      }),
    )
  })
})
