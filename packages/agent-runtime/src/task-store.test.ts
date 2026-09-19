import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import {
  type TestDatabaseService,
  TestDatabase,
  testDatabaseConfigured,
  testDatabaseLayer,
} from './testdb.ts'

/** Register teardown before removing stale rows or creating the test fixture. */
const prepareTaskFixture = Effect.fn('TaskStoreTest.prepareTaskFixture')(function* (
  database: TestDatabaseService,
  taskId: string,
) {
  yield* Effect.addFinalizer(() => database.cleanupTask(taskId).pipe(Effect.orDie))
  yield* database.cleanupTask(taskId)
})

describe.skipIf(!testDatabaseConfigured)('task store', () => {
  layer(testDatabaseLayer)((it) => {
    it.effect('a running follow-up preserves the Flue submission needed to resume it', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        const taskId = NodeCrypto.randomUUID()
        yield* prepareTaskFixture(database, taskId)

        const task = yield* Effect.tryPromise(() =>
          database.taskStore.createTask({
            id: taskId,
            title: 'Signed NDA from Dami',
            origin: { kind: 'manual' },
            createdBy: 'you',
          }),
        )
        const followUp = yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            taskId: task.id,
            at: Date.now(),
            createdBy: 'you',
          }),
        )
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.startFollowUp(followUp.id, 1_700_000_000_000),
          ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.attachFollowUpSubmission(followUp.id, 'submission-123'),
          ),
        ).toBe(true)

        const resumable = (yield* Effect.tryPromise(() =>
          database.taskStore.listRunningFollowUps(),
        )).find((item) => item.id === followUp.id)
        expect(resumable).toMatchObject({
          submissionId: 'submission-123',
          firedAt: 1_700_000_000_000,
        })
      }),
    )

    it.effect('a recovered follow-up can only be finalized once', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        const taskId = NodeCrypto.randomUUID()
        yield* prepareTaskFixture(database, taskId)

        const task = yield* Effect.tryPromise(() =>
          database.taskStore.createTask({
            id: taskId,
            title: 'Review investor notes',
            origin: { kind: 'manual' },
            createdBy: 'you',
          }),
        )
        const followUp = yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            taskId: task.id,
            at: Date.now(),
            createdBy: 'you',
          }),
        )
        yield* Effect.tryPromise(() => database.taskStore.startFollowUp(followUp.id, Date.now()))

        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.finishFollowUp(followUp.id, 'First durable result'),
          ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.finishFollowUp(followUp.id, 'Duplicate result'),
          ),
        ).toBe(false)
        const finished = yield* Effect.tryPromise(() => database.taskStore.getFollowUp(followUp.id))
        expect(finished).toMatchObject({ output: 'First durable result' })
      }),
    )

    it.effect('follow-up completion and its notification materialize once', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        const taskId = NodeCrypto.randomUUID()
        yield* prepareTaskFixture(database, taskId)

        const task = yield* Effect.tryPromise(() =>
          database.taskStore.createTask({
            id: taskId,
            title: 'Confirm launch date',
            assignee: 'Dami',
            origin: { kind: 'manual' },
            createdBy: 'you',
          }),
        )
        const followUp = yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            taskId: task.id,
            at: Date.now(),
            createdBy: 'you',
          }),
        )
        yield* Effect.tryPromise(() => database.taskStore.startFollowUp(followUp.id, Date.now()))
        const completion = {
          output: 'Dami still needs to confirm the launch date.',
          nextFollowUp: {
            at: 1_900_000_000_000,
            note: 'Keep chasing',
            repeatEveryMs: 86_400_000,
            createdBy: 'vivid' as const,
          },
          notification: {
            kind: 'follow-up' as const,
            title: 'Chased Dami: Confirm launch date',
            body: 'Dami still needs to confirm the launch date.',
            taskId: task.id,
            conversationId: task.conversationId,
          },
        }

        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.completeFollowUp(followUp.id, completion),
          ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.completeFollowUp(followUp.id, completion),
          ),
        ).toBe(false)
        expect(
          (yield* Effect.tryPromise(() => database.taskStore.listNotifications())).filter(
            (item) => item.taskId === task.id,
          ),
        ).toHaveLength(1)
        expect(
          (yield* Effect.tryPromise(() => database.taskStore.listFollowUps(task.id))).filter(
            (item) => item.status === 'scheduled',
          ),
        ).toHaveLength(1)
      }),
    )

    it.effect('stable operation ids make retried task side effects idempotent', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        const taskId = '11111111-1111-4111-8111-111111111111'
        const followUpId = '22222222-2222-4222-8222-222222222222'
        const notificationId = '33333333-3333-4333-8333-333333333333'
        yield* prepareTaskFixture(database, taskId)

        const input = {
          id: taskId,
          title: 'Send revised deck',
          origin: { kind: 'manual' } as const,
          createdBy: 'vivid' as const,
        }
        const first = yield* Effect.tryPromise(() => database.taskStore.createTask(input))
        const replay = yield* Effect.tryPromise(() => database.taskStore.createTask(input))
        yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            id: followUpId,
            taskId,
            at: 1_800_000_000_000,
            createdBy: 'vivid',
          }),
        )
        yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            id: followUpId,
            taskId,
            at: 1_800_000_000_000,
            createdBy: 'vivid',
          }),
        )
        yield* Effect.tryPromise(() =>
          database.taskStore.createNotification({
            id: notificationId,
            kind: 'tracked',
            title: 'Now tracking',
            taskId,
          }),
        )
        yield* Effect.tryPromise(() =>
          database.taskStore.createNotification({
            id: notificationId,
            kind: 'tracked',
            title: 'Now tracking',
            taskId,
          }),
        )

        expect(first.id).toBe(replay.id)
        expect(
          (yield* Effect.tryPromise(() => database.taskStore.listTasks())).filter(
            (item) => item.id === taskId,
          ),
        ).toHaveLength(1)
        expect(
          yield* Effect.tryPromise(() => database.taskStore.listFollowUps(taskId)),
        ).toHaveLength(1)
        expect(
          (yield* Effect.tryPromise(() => database.taskStore.listNotifications())).filter(
            (item) => item.id === notificationId,
          ),
        ).toHaveLength(1)
      }),
    )

    it.effect('a follow-up that fired around the due time covers the overdue sweep', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        const taskId = NodeCrypto.randomUUID()
        const dueAt = 1_800_000_000_000
        const since = dueAt - 60 * 60 * 1_000
        yield* prepareTaskFixture(database, taskId)

        const task = yield* Effect.tryPromise(() =>
          database.taskStore.createTask({
            id: taskId,
            title: 'Invoice to Kestrel',
            dueAt,
            origin: { kind: 'manual' },
            createdBy: 'you',
          }),
        )
        expect(
          yield* Effect.tryPromise(() => database.taskStore.hasFollowUpCovering(task.id, since)),
        ).toBe(false)

        const followUp = yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            taskId: task.id,
            at: dueAt,
            createdBy: 'vivid',
          }),
        )
        expect(
          yield* Effect.tryPromise(() => database.taskStore.hasFollowUpCovering(task.id, since)),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.startFollowUp(followUp.id, dueAt + 5_000),
          ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() => database.taskStore.hasFollowUpCovering(task.id, since)),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() => database.taskStore.finishFollowUp(followUp.id, 'nudged')),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() => database.taskStore.hasFollowUpCovering(task.id, since)),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.taskStore.hasFollowUpCovering(task.id, dueAt + 10_000),
          ),
        ).toBe(false)

        const stale = yield* Effect.tryPromise(() =>
          database.taskStore.createFollowUp({
            taskId: task.id,
            at: since - 1,
            createdBy: 'vivid',
          }),
        )
        yield* Effect.tryPromise(() => database.taskStore.startFollowUp(stale.id, since - 1))
        yield* Effect.tryPromise(() => database.taskStore.finishFollowUp(stale.id, 'early nudge'))
        expect(
          yield* Effect.tryPromise(() => database.taskStore.hasFollowUpCovering(task.id, since)),
        ).toBe(true)
      }),
    )
  })
})
