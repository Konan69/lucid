import { describe, expect, layer } from '@effect/vitest'
import {
  Conflict,
  NotFound,
  OwedListResponse,
  OwedState,
  SessionId,
  TrackOwedRequest,
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
import { owedHandlers } from './handlers.ts'
import { OwedStore, owedStoreLayer } from './store.ts'

const testLayer = Layer.merge(owedStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

/** Exercise the real store, session-backed WatchOwed and PostgreSQL change bus in one owned fixture. */
describe.skipIf(!testDatabaseConfigured)('Waiting on', () => {
  layer(testLayer)((it) => {
    it.effect('tracks, updates, nudges, closes, isolates owners and refreshes WatchOwed', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* OwedStore
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
        const values = yield* Queue.unbounded<OwedListResponse>()
        const fiber = yield* owedHandlers.WatchOwed().pipe(
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
        expect((yield* Queue.take(values)).owed).toEqual([])
        const receipt = yield* (yield* Changes).subscribe(
          [Topic.person(test.personal.person.id)],
          everyPart,
        )
        const request = {
          threadId: test.personalId,
          what: 'the signed NDA',
          from: 'Dana',
          since: 100,
          due: 500,
          nextStep: 'Ask Dana on Friday',
        } satisfies TrackOwedRequest
        const tracked = yield* store.track(test.personal, request)
        expect(tracked).toMatchObject({
          personId: test.personal.person.id,
          what: request.what,
          from: 'Dana',
          state: OwedState.cases.Open.make({}),
        })
        expect((yield* nextValue({ values, receipt, fiber })).owed).toEqual([tracked])
        expect(yield* store.list(test.other)).toEqual([])
        for (const mutate of [
          store.update(test.other, {
            id: tracked.id,
            due: null,
            blockedOn: null,
            nextStep: 'Change it',
          }),
          store.nudged(test.other, { id: tracked.id, at: 200 }),
          store.resolve(test.other, { id: tracked.id, how: 'Arrived' }),
          store.drop(test.other, { id: tracked.id, why: 'No longer needed' }),
        ])
          expect(yield* Effect.flip(mutate)).toBeInstanceOf(NotFound)
        expect(yield* Effect.flip(store.track(test.other, request))).toBeInstanceOf(NotFound)
        const updated = yield* store.update(test.personal, {
          id: tracked.id,
          due: 600,
          blockedOn: 'Legal review',
          nextStep: 'Wait for legal',
        })
        expect(updated).toMatchObject({
          due: 600,
          blockedOn: 'Legal review',
          nextStep: 'Wait for legal',
        })
        yield* store.nudged(test.personal, { id: tracked.id, at: 200 })
        expect((yield* store.nudged(test.personal, { id: tracked.id, at: 300 })).state).toEqual(
          OwedState.cases.Nudged.make({ count: 2, lastAt: 300 }),
        )
        const resolved = yield* store.resolve(test.personal, {
          id: tracked.id,
          how: 'Dana sent the signed PDF',
        })
        expect(resolved.state).toEqual(
          OwedState.cases.Resolved.make({
            at: yield* Clock.currentTimeMillis,
            how: 'Dana sent the signed PDF',
          }),
        )
        const second = yield* store.track(
          test.personal,
          TrackOwedRequest.make({ ...request, what: 'a delivery', due: null }),
        )
        const dropped = yield* store.drop(test.personal, { id: second.id, why: 'Order cancelled' })
        expect(dropped.state).toEqual(
          OwedState.cases.Dropped.make({
            at: yield* Clock.currentTimeMillis,
            why: 'Order cancelled',
          }),
        )
        for (const id of [tracked.id, second.id]) {
          for (const mutate of [
            store.update(test.personal, { id, due: null, blockedOn: null, nextStep: 'Reopen' }),
            store.nudged(test.personal, { id, at: 400 }),
            store.resolve(test.personal, { id, how: 'Again' }),
            store.drop(test.personal, { id, why: 'Again' }),
          ])
            expect(yield* Effect.flip(mutate)).toBeInstanceOf(Conflict)
        }
        const companyRecord = yield* store.track(
          test.member,
          TrackOwedRequest.make({ ...request, threadId: test.companyId }),
        )
        expect(yield* store.list(test.owner)).toEqual([])
        expect(
          yield* Effect.flip(
            store.resolve(test.owner, {
              id: companyRecord.id,
              how: 'Owner cannot close another Person’s record',
            }),
          ),
        ).toBeInstanceOf(NotFound)
        const undated = yield* store.track(
          test.personal,
          TrackOwedRequest.make({ ...request, what: 'a reply', due: null }),
        )
        const urgent = yield* store.track(
          test.personal,
          TrackOwedRequest.make({ ...request, what: 'a decision', due: 50 }),
        )
        expect((yield* store.list(test.personal)).map((record) => record.id).slice(0, 2)).toEqual([
          urgent.id,
          undated.id,
        ])
        expect(
          (yield* store.list(test.personal)).filter((record) =>
            OwedState.isAnyOf(['Resolved', 'Dropped'])(record.state),
          ),
        ).toHaveLength(2)
      }).pipe(Effect.scoped),
    )
  })
})
