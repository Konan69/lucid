import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  BrowserAction,
  BrowseOutcome,
  BrowseResult,
  DeviceAnswer,
  DeviceRequest,
  DeviceRequestId,
  PersonId,
  SessionId,
} from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { personTable } from '../auth/tables.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Device, deviceLayer, DeviceReceipt } from './device.ts'
import { deviceRequests } from './tables.ts'

const testLayer = deviceLayer.pipe(Layer.provideMerge(testDatabaseLayer))
const decodeReceipt = Schema.decodeUnknownEffect(DeviceReceipt)
const encodeReceipt = Schema.encodeSync(DeviceReceipt)
const encodeRequest = Schema.encodeSync(DeviceRequest)
const result = BrowseResult.make({
  address: 'https://example.test',
  title: 'Signed-in page',
  outline: 'The signed-in account',
  truncated: false,
  tabs: [{ address: 'https://example.test', title: 'Signed-in page', showing: true }],
})

/** Register cascading cleanup before any fixture write; only the test database can provide this Layer. */
const fixture = Effect.fn('DeviceTest.fixture')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, personId))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Device fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Device test', email: `${personId}@example.test` }),
  )
  return { database, personId, sessionId }
})

/** A child scope lets the test disconnect one device without destroying the server's authority. */
const connect = Effect.fn('DeviceTest.connect')(function* (
  personId: PersonId,
  sessionId: SessionId,
) {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const stream = yield* (yield* Device)
    .watch(personId, sessionId)
    .pipe(Effect.provideService(Scope.Scope, scope))
  const requests = yield* Queue.unbounded<DeviceRequest>()
  yield* stream.pipe(
    Stream.runForEach((request) => Queue.offer(requests, request)),
    Effect.forkIn(scope),
  )
  return { requests, close: Scope.close(scope, Exit.void) }
})

/** Real PostgreSQL owns the dispatch and receipt; a fake desktop controls only its answers. */
describe.skipIf(!testDatabaseConfigured)('Person browser device channel', () => {
  it.effect('fails without a device and never allocates or falls back to a cloud Computer', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const device = yield* Device
      const failed = yield* device
        .browse({
          personId: test.personId,
          threadId: Option.none(),
          action: BrowserAction.cases.Read.make({}),
        })
        .pipe(Effect.flip)
      expect(failed._tag).toBe('NoDeviceConnected')
      expect(
        yield* test.database.run(
          test.database
            .select()
            .from(deviceRequests)
            .where(eq(deviceRequests.personId, test.personId)),
        ),
      ).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'delivers once to one subscription, checks Person/session, and persists the answer before returning',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const first = yield* connect(test.personId, test.sessionId)
        const second = yield* connect(test.personId, SessionId.make(NodeCrypto.randomUUID()))
        const device = yield* Device
        const running = yield* device
          .browse({
            personId: test.personId,
            threadId: Option.none(),
            action: BrowserAction.cases.Read.make({}),
          })
          .pipe(Effect.forkScoped)
        const request = yield* Queue.take(first.requests)
        const wrong = yield* device
          .answer(PersonId.make('someone-else'), test.sessionId, {
            id: request.id,
            answer: DeviceAnswer.cases.Done.make({ result }),
          })
          .pipe(Effect.flip)
        expect(wrong._tag).toBe('Forbidden')
        const other = yield* device
          .answer(test.personId, SessionId.make('other-session'), {
            id: request.id,
            answer: DeviceAnswer.cases.Done.make({ result }),
          })
          .pipe(Effect.flip)
        expect(other._tag).toBe('Forbidden')
        yield* device.answer(test.personId, test.sessionId, {
          id: request.id,
          answer: DeviceAnswer.cases.Done.make({ result }),
        })
        expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.Completed.make({ result }))
        const [row] = yield* test.database.run(
          test.database.select().from(deviceRequests).where(eq(deviceRequests.id, request.id)),
        )
        expect(row).toBeDefined()
        if (row === undefined) return yield* Effect.die('Missing device receipt')
        expect(yield* decodeReceipt(row.state)).toEqual(
          DeviceReceipt.cases.Answered.make({ answer: DeviceAnswer.cases.Done.make({ result }) }),
        )
        expect(yield* Queue.size(second.requests)).toBe(0)
        const repeated = yield* device
          .answer(test.personId, test.sessionId, {
            id: request.id,
            answer: DeviceAnswer.cases.Done.make({ result }),
          })
          .pipe(Effect.flip)
        expect(repeated._tag).toBe('Forbidden')
        return undefined
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('disconnect makes a dispatched action uncertain and reconnect never replays it', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const first = yield* connect(test.personId, test.sessionId)
      const device = yield* Device
      const running = yield* device
        .browse({
          personId: test.personId,
          threadId: Option.none(),
          action: BrowserAction.cases.Click.make({ target: 'Submit' }),
        })
        .pipe(Effect.forkScoped)
      const request = yield* Queue.take(first.requests)
      yield* first.close
      expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
      const reconnected = yield* connect(test.personId, test.sessionId)
      expect(yield* Queue.size(reconnected.requests)).toBe(0)
      expect(
        (yield* device
          .answer(test.personId, test.sessionId, {
            id: request.id,
            answer: DeviceAnswer.cases.Done.make({ result }),
          })
          .pipe(Effect.flip))._tag,
      ).toBe('Forbidden')
      const [row] = yield* test.database.run(
        test.database.select().from(deviceRequests).where(eq(deviceRequests.id, request.id)),
      )
      expect(row === undefined ? 'absent' : row.status).toBe('unknown')
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('deadline closes the request and a late receipt cannot authorize another attempt', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const connected = yield* connect(test.personId, test.sessionId)
      const device = yield* Device
      const running = yield* device
        .browse({
          personId: test.personId,
          threadId: Option.none(),
          action: BrowserAction.cases.Type.make({ target: 'Name', text: 'one attempt' }),
        })
        .pipe(Effect.forkScoped)
      const request = yield* Queue.take(connected.requests)
      yield* TestClock.adjust('30 seconds')
      expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
      expect(
        (yield* device
          .answer(test.personId, test.sessionId, {
            id: request.id,
            answer: DeviceAnswer.cases.Failed.make({}),
          })
          .pipe(Effect.flip))._tag,
      ).toBe('Forbidden')
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('a fresh server authority cannot replay or accept an abandoned durable dispatch', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const abandoned = DeviceRequest.make({
        id: DeviceRequestId.make(NodeCrypto.randomUUID()),
        action: BrowserAction.cases.Click.make({ target: 'Submit' }),
        expiresAt: 30_000,
      })
      // This is the crash boundary: PostgreSQL committed a dispatch, but process-local authority is gone.
      yield* test.database.run(
        test.database.insert(deviceRequests).values({
          id: abandoned.id,
          personId: test.personId,
          sessionId: test.sessionId,
          subscriptionId: NodeCrypto.randomUUID(),
          threadId: null,
          request: encodeRequest(abandoned),
          expiresAt: abandoned.expiresAt,
          status: 'dispatched',
          state: encodeReceipt(DeviceReceipt.cases.Dispatched.make({})),
        }),
      )
      yield* Effect.gen(function* () {
        const connected = yield* connect(test.personId, test.sessionId)
        expect(yield* Queue.size(connected.requests)).toBe(0)
        const rejected = yield* (yield* Device)
          .answer(test.personId, test.sessionId, {
            id: abandoned.id,
            answer: DeviceAnswer.cases.Done.make({ result }),
          })
          .pipe(Effect.flip)
        expect(rejected._tag).toBe('Forbidden')
        const [row] = yield* test.database.run(
          test.database.select().from(deviceRequests).where(eq(deviceRequests.id, abandoned.id)),
        )
        expect(row === undefined ? 'absent' : row.status).toBe('dispatched')
      }).pipe(Effect.provide(Layer.fresh(deviceLayer)))
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )
})
