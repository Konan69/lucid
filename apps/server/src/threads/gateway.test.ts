import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import {
  ConversationFrame,
  CompanyId,
  PersonId,
  ThreadId,
  emptyConversation,
} from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Context, Effect, Exit, Fiber, Layer, PubSub, Queue, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic, silentChangesLayer } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { authenticate } from '../auth/session.ts'
import { AuthContext } from '@vivid/contracts/auth'
import { watchConversation } from './socket.ts'
import { threads } from './tables.ts'
import { authLayer } from '../auth/provider.ts'

/**
 * The change bus in memory. `watching` hears every subscription, so a test that must act after
 * the open read is listening takes from it instead of waiting on time.
 */
interface BusService {
  readonly watching: Queue.Queue<void>
}
class Bus extends Context.Service<Bus, BusService>()('vivid/test/GatewayBus') {}

const busLayer = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<ReadonlyArray<Topic>>()
    const watching = yield* Queue.unbounded<void>()
    const changes = Changes.of({
      publish: (topics) => PubSub.publish(hub, topics).pipe(Effect.asVoid),
      subscribe: Effect.fn('GatewayTest.subscribe')(function* (topics) {
        const subscription = yield* PubSub.subscribe(hub)
        yield* Queue.offer(watching, undefined)
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((moved) => moved.some((topic) => topics.includes(topic))),
          Stream.map(() => undefined),
        )
      }),
    })
    return Layer.mergeAll(Layer.succeed(Bus, { watching }), Layer.succeed(Changes, changes))
  }),
)

/** The session outlives every real clock a test runs under; only a controlled clock reaches it. */
const expiresAt = new Date('2100-01-01T00:00:00Z')

/** Ada, a Member of a Company, signed in, with a Thread the whole Company sees. */
const fixture = Effect.fn('GatewayTest.fixture')(function* () {
  const database = yield* Database
  const ada = PersonId.make(NodeCrypto.randomUUID())
  const owner = PersonId.make(NodeCrypto.randomUUID())
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const sessionId = NodeCrypto.randomUUID()
  const token = NodeCrypto.randomUUID()
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
      Effect.andThen(
        database.run(database.delete(companyTable).where(eq(companyTable.id, companyId))),
      ),
      Effect.andThen(database.run(database.delete(personTable).where(eq(personTable.id, ada)))),
      Effect.andThen(database.run(database.delete(personTable).where(eq(personTable.id, owner)))),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Gateway fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database.insert(personTable).values([
      { id: ada, name: 'Ada', email: `${ada}@example.test` },
      { id: owner, name: 'Owner', email: `${owner}@example.test` },
    ]),
  )
  yield* database.run(
    database.insert(companyTable).values({ id: companyId, name: 'Gateway test', slug: companyId }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: NodeCrypto.randomUUID(), companyId, userId: ada, role: 'member' },
      { id: NodeCrypto.randomUUID(), companyId, userId: owner, role: 'owner' },
    ]),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      personId: owner,
      companyId,
      audience: 'company',
      title: 'Gateway test',
      titleSource: 'Person',
      updatedAt: 0,
    }),
  )
  yield* database.run(
    database.insert(sessionTable).values({ id: sessionId, token, userId: ada, expiresAt }),
  )
  return { ada, companyId, threadId, sessionId, token }
})

type Fixture = Effect.Success<ReturnType<typeof fixture>>

const removeMembership = Effect.fn('GatewayTest.removeMembership')(function* (test: Fixture) {
  const database = yield* Database
  yield* database.run(
    database
      .delete(membershipTable)
      .where(
        and(eq(membershipTable.companyId, test.companyId), eq(membershipTable.userId, test.ada)),
      ),
  )
})

const removeSession = Effect.fn('GatewayTest.removeSession')(function* (test: Fixture) {
  const database = yield* Database
  yield* database.run(database.delete(sessionTable).where(eq(sessionTable.id, test.sessionId)))
})

const hello = ConversationFrame.cases.Whole.make({ state: emptyConversation })

/** A lazy runtime link can revoke access during opening, before a buffered frame is returned. */
const requestRead = Effect.fn('GatewayTest.requestRead')(function* (
  test: Fixture,
  whileOpening: Effect.Effect<void, DatabaseInfrastructureError, Database>,
) {
  const database = yield* Database
  const auth = yield* authenticate(new Headers({ authorization: `Bearer ${test.token}` }))
  const context = yield* Layer.build(
    Layer.mock(Runtime, {
      watch: () =>
        Stream.unwrap(
          whileOpening.pipe(
            Effect.provideService(Database, database),
            Effect.catch(() => Effect.sync(() => expect.fail('The test could not change state'))),
            Effect.as(Stream.concat(Stream.make(hello), Stream.never)),
          ),
        ),
    }),
  )
  return watchConversation({ threadId: test.threadId }).pipe(
    Stream.provideService(AuthContext, auth),
    Stream.provideContext(context),
  )
})

/** Body consumption starts separately, allowing removal after headers but before its first pull. */
const consumeRead = Effect.fn('GatewayTest.consumeRead')(function* (
  response: Effect.Success<ReturnType<typeof requestRead>>,
) {
  const received = yield* Queue.unbounded<ConversationFrame>()
  const ended = yield* response.pipe(
    Stream.runForEach((frame) => Queue.offer(received, frame)),
    Effect.forkScoped,
  )
  return { received, ended }
})

/** The ordinary client path starts consuming immediately after receiving its response. */
const openRead = Effect.fn('GatewayTest.openRead')(function* (test: Fixture) {
  return yield* consumeRead(yield* requestRead(test, Effect.void))
})

/** The combined authority watcher has subscribed to the change bus. */
const listening = Effect.fn('GatewayTest.listening')(function* () {
  const bus = yield* Bus
  yield* Queue.take(bus.watching)
})

const foundation = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  silentChangesLayer,
  authLayer.pipe(Layer.provide(testConfigLayer)),
)
const audible = busLayer

/** The database is shared; each read owns a fresh bus so subscriptions cannot leak between cases. */
layer(foundation, { excludeTestServices: true })((it) => {
  describe.skipIf(!testDatabaseConfigured)('An open conversation read', () => {
    /** No change is ever announced here: only asking again after subscribing can end the read. */
    it.effect('refuses when the Person lost the Thread while the runtime was opening it', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const response = yield* requestRead(test, removeMembership(test))
        const read = yield* consumeRead(response)
        expect(Exit.isFailure(yield* Fiber.await(read.ended))).toBe(true)
        expect(yield* Queue.size(read.received)).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.effect('refuses when the session was removed while the runtime was opening it', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const response = yield* requestRead(test, removeSession(test))
        const read = yield* consumeRead(response)
        expect(Exit.isFailure(yield* Fiber.await(read.ended))).toBe(true)
        expect(yield* Queue.size(read.received)).toBe(0)
      }).pipe(Effect.scoped),
    )

    for (const removal of [removeMembership, removeSession]) {
      it.effect(
        `withholds buffered bytes when ${removal === removeSession ? 'session' : 'membership'} ends before body consumption`,
        () =>
          Effect.gen(function* () {
            const test = yield* fixture()
            const response = yield* requestRead(test, Effect.void)
            yield* removal(test)
            const read = yield* consumeRead(response)
            expect(Exit.isFailure(yield* Fiber.await(read.ended))).toBe(
              removal === removeMembership,
            )
            expect(yield* Queue.size(read.received)).toBe(0)
          }).pipe(Effect.scoped),
      )
    }

    /** The Person can still see the Thread; only the session that opened the read is gone. */
    it.effect('ends when its session is signed out, though the Person still sees the Thread', () =>
      Effect.gen(function* () {
        // Each scoped read owns its mock ports and bus subscriptions.
        const context = yield* Layer.build(audible)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const read = yield* openRead(test)
          yield* listening()
          expect(yield* Queue.take(read.received)).toEqual(hello)
          yield* removeSession(test)
          yield* (yield* Changes).publish([Topic.person(test.ada)])
          expect(Exit.isSuccess(yield* Fiber.await(read.ended))).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('ends when the Person is removed from the Company after it opened', () =>
      Effect.gen(function* () {
        // Each scoped read owns its mock ports and bus subscriptions.
        const context = yield* Layer.build(audible)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const read = yield* openRead(test)
          yield* listening()
          expect(yield* Queue.take(read.received)).toEqual(hello)
          yield* removeMembership(test)
          yield* (yield* Changes).publish([Topic.company(test.companyId)])
          expect(Exit.isSuccess(yield* Fiber.await(read.ended))).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})

layer(foundation)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Conversation session expiry', () => {
    /** Nothing is written and nothing is published when a session runs out; only the clock moves. */
    it.effect('ends when its session runs out, with no write and no announcement', () =>
      Effect.gen(function* () {
        // Each scoped read owns its mock ports and bus subscriptions.
        const context = yield* Layer.build(audible)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const read = yield* openRead(test)
          yield* listening()
          expect(yield* Queue.take(read.received)).toEqual(hello)
          yield* TestClock.setTime(expiresAt.getTime() - 1)
          expect(read.ended.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(1)
          expect(Exit.isSuccess(yield* Fiber.await(read.ended))).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
