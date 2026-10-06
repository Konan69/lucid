import { PersonId, SessionId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, it, layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Redacted, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer, testConfigLayer } from '../database/testdb.ts'
import { Changes, silentChangesLayer } from '../live/changes.ts'
import { absentMachineLayer } from './testing.ts'
import { ComputerStore, computerStoreLayer } from './store.ts'
import { screenLifetime, screenOriginAllowed } from './screen.ts'

describe('Computer screen browser origin', () => {
  it('requires the configured scheme, host and port, including behind a Host-rewriting proxy', () => {
    const publicUrl = new URL('https://vivid.example:8443')
    expect(screenOriginAllowed(Option.some('https://vivid.example:8443'), publicUrl)).toBe(true)
    for (const origin of [
      'http://vivid.example:8443',
      'https://vivid.example',
      'https://other.example:8443',
      'null',
      'malformed',
      'https://vivid.example:8443/path',
    ])
      expect(screenOriginAllowed(Option.some(origin), publicUrl)).toBe(false)
    expect(screenOriginAllowed(Option.none(), publicUrl)).toBe(false)
  })
})

const lifetimeDependencies = Layer.mergeAll(testDatabaseLayer, testConfigLayer, silentChangesLayer)
const lifetimeStores = computerStoreLayer.pipe(
  Layer.provideMerge(lifetimeDependencies),
  Layer.provide(absentMachineLayer),
)

/** Session persistence is real; a controlled Computer endpoint isolates lifetime from provider availability. */
const lifetimeFixture = Effect.fn('Computer.screen.test.lifetime')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, personId))).pipe(
      Effect.tapError((error) => Effect.logError('Screen lifetime cleanup failed', error._tag)),
      Effect.ignore,
    ),
  )
  yield* TestClock.setTime(0)
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Lifetime', email: `${personId}@screen.test` }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: personId,
      token: NodeCrypto.randomUUID(),
      expiresAt: new Date(60_000),
    }),
  )
  const moved = yield* PubSub.unbounded<void>()
  const checked = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const store = yield* ComputerStore
  const controlled = ComputerStore.of({
    ...store,
    screen: Effect.fn('Computer.screen.test.endpoint')(function* () {
      yield* Deferred.succeed(checked, undefined)
      if (yield* Deferred.isDone(stopped)) return Option.none()
      return Option.some({
        address: 'ws://127.0.0.1:1',
        authorization: Redacted.make('test-screen'),
      })
    }),
  })
  const changes = Changes.of({
    publish: () => PubSub.publish(moved, undefined).pipe(Effect.asVoid),
    subscribe: () => PubSub.subscribe(moved).pipe(Effect.map(Stream.fromSubscription)),
  })
  const lifetime = yield* screenLifetime({ personId, sessionId }).pipe(
    Effect.provideService(ComputerStore, controlled),
    Effect.provideService(Changes, changes),
  )
  const worker = yield* lifetime.pipe(Effect.forkChild)
  yield* Deferred.await(checked)
  return { database, personId, sessionId, moved, stopped, worker }
})

describe.skipIf(!testDatabaseConfigured)('Computer screen lifetime', () => {
  layer(lifetimeStores)((test) => {
    test.effect(
      'revokes screen authority after session deletion without a change notification',
      () =>
        Effect.gen(function* () {
          const fixture = yield* lifetimeFixture()
          yield* fixture.database.run(
            fixture.database.delete(sessionTable).where(eq(sessionTable.id, fixture.sessionId)),
          )
          yield* TestClock.adjust('5 seconds')
          expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
        }),
    )
    test.effect('revokes screen authority at session expiry using the controllable clock', () =>
      Effect.gen(function* () {
        const fixture = yield* lifetimeFixture()
        yield* TestClock.adjust('60 seconds')
        expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
      }),
    )
    test.effect('revokes screen authority when the Computer stops and publishes its change', () =>
      Effect.gen(function* () {
        const fixture = yield* lifetimeFixture()
        yield* Deferred.succeed(fixture.stopped, undefined)
        yield* PubSub.publish(fixture.moved, undefined)
        expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
      }),
    )
  })
})
