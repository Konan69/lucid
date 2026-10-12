import type { PgClient } from '@effect/sql-pg/PgClient'
import { expect } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Database } from '../database/client.ts'
import { announce, Changes, Topic } from './changes.ts'
import { watch } from './query.ts'

const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))
type Notifications = Effect.Success<ReturnType<PgClient['listen']>>

// Shared by Project and Rule integration suites; copied from threads/announcements.test.ts.
// The raw LISTEN marker orders commit receipts; the companion bus receipt controls watch's clock.
/** A unique unused Person topic orders this transaction after the operation under test. */
const sendMarker = Effect.fn('LiveTesting.sendMarker')(function* () {
  const topic = Topic.person(PersonId.make(crypto.randomUUID()))
  yield* (yield* Database).transaction((tx) => announce(tx, [topic]))
  return topic
})

/** Compare the first receipt against a later marker: missing notices fail promptly even on red code. */
export const payload = Effect.fn('LiveTesting.payload')(function* (
  notifications: Notifications,
  expected: ReadonlyArray<Topic>,
) {
  const marker = yield* sendMarker()
  const topics = yield* decodeTopics((yield* Queue.take(notifications)).payload)
  expect(topics.toSorted()).toEqual(expected.toSorted())
  // The next ordered receipt must be the marker, proving exactly one notice for this operation.
  expect(yield* decodeTopics((yield* Queue.take(notifications)).payload)).toEqual([marker])
})

/** PostgreSQL's ordered marker proves the refused/no-op operation emitted nothing. */
export const silent = Effect.fn('LiveTesting.silent')(function* (notifications: Notifications) {
  const topic = yield* sendMarker()
  expect(yield* decodeTopics((yield* Queue.take(notifications)).payload)).toEqual([topic])
})

/** Observe real watch loading and subscribe to the real bus before any tested mutation. */
export const observing = Effect.fn('LiveTesting.observing')(function* <A, E, R>(
  topics: ReadonlyArray<Topic>,
  load: Effect.Effect<A, E, R>,
) {
  const first = yield* Deferred.make<void>()
  const values = yield* Queue.unbounded<A>()
  const fiber = yield* watch('Session', topics, load).pipe(
    Stream.runForEach((value) =>
      Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
    ),
    Effect.forkScoped,
  )
  yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
  const initial = yield* Queue.take(values)
  const receipt = yield* (yield* Changes).subscribe(topics)
  return { initial, values, receipt, fiber }
})

/** The actual bus receipt precedes advancing watch's controlled debounce clock. */
export const nextValue = Effect.fn('LiveTesting.nextValue')(function* <A, E>(observation: {
  readonly values: Queue.Queue<A>
  readonly receipt: Stream.Stream<void>
  readonly fiber: Fiber.Fiber<void, E>
}) {
  expect(Option.isSome(yield* Stream.runHead(observation.receipt))).toBe(true)
  yield* TestClock.adjust('20 millis')
  return yield* Effect.raceFirst(
    Queue.take(observation.values),
    Fiber.join(observation.fiber).pipe(Effect.andThen(Effect.never)),
  )
})
