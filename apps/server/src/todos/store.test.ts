import { describe, expect, layer } from '@effect/vitest'
import {
  AddTodoRequest,
  Conflict,
  NotFound,
  SessionId,
  TodoListResponse,
  TodoState,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Clock, Deferred, Effect, Fiber, Layer, Queue } from 'effect'
import * as Stream from 'effect/Stream'
import { fixture } from '../approvals/testing.ts'
import { sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, changesLayer, everyPart, Topic } from '../live/changes.ts'
import { nextValue } from '../live/testing.ts'
import { todoHandlers } from './handlers.ts'
import { TodoStore, todoStoreLayer } from './store.ts'

const testLayer = Layer.merge(todoStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

/** The real store, session-backed WatchTodos and PostgreSQL change bus in one owned fixture. */
describe.skipIf(!testDatabaseConfigured)('To-dos', () => {
  layer(testLayer)((it) => {
    it.effect(
      'adds, ticks off once, drops with a reason, isolates lists and refreshes WatchTodos',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* TodoStore
          const database = yield* Database
          const sessionId = SessionId.make(crypto.randomUUID())
          yield* database.run(
            database.insert(sessionTable).values({
              id: sessionId,
              token: crypto.randomUUID(),
              userId: test.personal.person.id,
              expiresAt: new Date((yield* Clock.currentTimeMillis) + 86_400_000),
            }),
          )
          const first = yield* Deferred.make<void>()
          const values = yield* Queue.unbounded<TodoListResponse>()
          const fiber = yield* todoHandlers.WatchTodos().pipe(
            Stream.runForEach((value) =>
              Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
            ),
            Effect.provideService(
              AuthContext,
              AuthState.Person({
                person: test.personal.person,
                workspace: test.personal.workspace,
                sessionId,
              }),
            ),
            Effect.forkScoped,
          )
          yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
          expect((yield* Queue.take(values)).todos).toEqual([])
          const receipt = yield* (yield* Changes).subscribe(
            [Topic.person(test.personal.person.id)],
            everyPart,
          )

          const request = AddTodoRequest.make({
            threadId: test.personalId,
            what: 'renew my passport',
            due: 500,
          })
          const added = yield* store.add(test.personal, request)
          expect(added).toMatchObject({
            personId: test.personal.person.id,
            threadId: test.personalId,
            what: 'renew my passport',
            due: 500,
            state: TodoState.cases.Open.make({}),
          })
          expect((yield* nextValue({ values, receipt, fiber })).todos).toEqual([added])

          // Another Person's list is unreachable: not listed, not closable, and their Thread is not
          // a place to add to it.
          expect(yield* store.list(test.other)).toEqual([])
          expect(yield* Effect.flip(store.complete(test.other, { id: added.id }))).toBeInstanceOf(
            NotFound,
          )
          expect(
            yield* Effect.flip(store.drop(test.other, { id: added.id, why: 'Not mine' })),
          ).toBeInstanceOf(NotFound)
          expect(yield* Effect.flip(store.add(test.other, request))).toBeInstanceOf(NotFound)

          // Two tick-offs at once, then a third: one Done, at the time of the first.
          const [once, twice] = yield* Effect.all(
            [
              store.complete(test.personal, { id: added.id }),
              store.complete(test.personal, { id: added.id }),
            ],
            { concurrency: 2 },
          )
          const done = TodoState.cases.Done.make({ at: yield* Clock.currentTimeMillis })
          expect(once.state).toEqual(done)
          expect(twice).toEqual(once)
          expect(yield* store.complete(test.personal, { id: added.id })).toEqual(once)
          expect(
            yield* Effect.flip(store.drop(test.personal, { id: added.id, why: 'Changed my mind' })),
          ).toBeInstanceOf(Conflict)

          const second = yield* store.add(
            test.personal,
            AddTodoRequest.make({ ...request, what: 'book the dentist', due: null }),
          )
          const dropped = yield* store.drop(test.personal, {
            id: second.id,
            why: 'The Person found a new dentist who books for them',
          })
          expect(dropped.state).toEqual(
            TodoState.cases.Dropped.make({
              at: yield* Clock.currentTimeMillis,
              why: 'The Person found a new dentist who books for them',
            }),
          )
          expect(
            yield* Effect.flip(store.complete(test.personal, { id: second.id })),
          ).toBeInstanceOf(Conflict)
          expect(
            yield* Effect.flip(store.drop(test.personal, { id: second.id, why: 'Again' })),
          ).toBeInstanceOf(Conflict)

          // A Company owner cannot reach a member's list in the same Company.
          const member = yield* store.add(
            test.member,
            AddTodoRequest.make({ ...request, threadId: test.companyId }),
          )
          expect(yield* store.list(test.owner)).toEqual([])
          expect(yield* Effect.flip(store.complete(test.owner, { id: member.id }))).toBeInstanceOf(
            NotFound,
          )

          // Open first, soonest date first and undated last; closed after.
          const undated = yield* store.add(
            test.personal,
            AddTodoRequest.make({ ...request, what: 'call the plumber', due: null }),
          )
          const urgent = yield* store.add(
            test.personal,
            AddTodoRequest.make({ ...request, what: 'pay the electricity bill', due: 50 }),
          )
          const listed = yield* store.list(test.personal)
          expect(listed.map((todo) => todo.id)).toEqual([
            urgent.id,
            undated.id,
            expect.anything(),
            expect.anything(),
          ])
          expect(
            listed
              .slice(2)
              .map((todo) => todo.state._tag)
              .sort(),
          ).toEqual(['Done', 'Dropped'])
        }).pipe(Effect.scoped),
    )
  })
})
