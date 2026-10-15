import { describe, expect, layer } from '@effect/vitest'
import { CreateWatchRequest, WatchId } from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Effect, Option, Queue, Ref } from 'effect'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { DeliveryMessage, StoredRunOrigin } from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { Watches } from './lifecycle.ts'
import { BACKGROUND_INSTRUCTION, threadOf } from './receiver.ts'
import { secretFor } from './signature.ts'
import { watchArrivals } from './tables.ts'
import { Delivered, Executor, person, receiver, testLayer } from './testing.ts'

const request = CreateWatchRequest.make({
  name: 'New mail in Work Mail',
  account: 'Mail (Work)',
  event: 'message.received',
  arguments: {},
  instruction: 'Tell me when a client writes.',
})
const occurrence = (eventId: string) =>
  JSON.stringify({
    eventId,
    name: 'mail.message.received',
    timestamp: '2026-10-15T20:00:00.000Z',
    data: { from: 'client@example.com', subject: 'Invoice' },
    cursor: null,
  })

/** The deliveries made for this Watch; the recording is shared by every test in the file. */
const deliveriesOf = Effect.fn('WatchTest.deliveriesOf')(function* (watch: WatchId) {
  const all = yield* Ref.get(yield* Delivered)
  return all.filter((delivery) => delivery.idempotencyKey.startsWith(`watch:${watch}:`))
})

/** An Active Watch, its callback and its secret, as Executor holds them. */
const activeWatch = Effect.fn('WatchTest.activeWatch')(function* () {
  const actor = yield* person()
  const executor = yield* Executor
  yield* Queue.offer(executor.answers, {
    id: `evs_${'3'.repeat(32)}`,
    refreshBefore: new Date(7 * 24 * 60 * 60_000),
  })
  const watch = yield* (yield* Watches).create(actor, request)
  const asked = yield* Queue.take(executor.subscribed)
  const secret = secretFor((yield* ServerConfig).AUTH_SECRET, watch.id)
  // The secret Executor was given is the one the receiver derives: the handshake depends on it.
  expect(asked.secret).toEqual(secret)
  return { actor, watch, url: asked.url, secret }
})

describe.skipIf(!testDatabaseConfigured)('Watch receiver', () => {
  layer(testLayer)((it) => {
    it.effect('echoes Executor’s signed challenge, and refuses a forged one', () =>
      Effect.gen(function* () {
        const post = yield* receiver()
        const { url, secret } = yield* activeWatch()
        const challenge = JSON.stringify({ type: 'verification', challenge: 'tok_123' })
        const answered = yield* post(url, challenge, secret, Option.none())
        expect(answered).toEqual({ status: 200, text: '{"challenge":"tok_123"}' })
        const forged = yield* post(url, challenge, secret, Option.some('v1,AAAA'))
        expect(forged.status).toBe(401)
      }).pipe(Effect.scoped),
    )

    it.effect('wakes Vivid once per event, in a background Thread nobody lists', () =>
      Effect.gen(function* () {
        const post = yield* receiver()
        const { actor, watch, url, secret } = yield* activeWatch()
        const first = yield* post(url, occurrence('evt_1'), secret, Option.none())
        expect(first.status).toBe(200)
        const repeat = yield* post(url, occurrence('evt_1'), secret, Option.none())
        expect(repeat.status).toBe(200)
        const delivered = yield* deliveriesOf(watch.id)
        expect(delivered).toHaveLength(1)
        const delivery = delivered[0]
        if (delivery === undefined) return expect.fail('Expected one delivery')
        const thread = threadOf(watch.id, 'evt_1')
        expect(delivery).toMatchObject({
          threadId: thread,
          personId: actor.person.id,
          idempotencyKey: `watch:${watch.id}:evt_1`,
        })
        expect(delivery.origin).toEqual(
          StoredRunOrigin.cases.Watch.make({ watchName: request.name }),
        )
        if (!DeliveryMessage.guards.Signal(delivery.message)) expect.fail('Expected a Signal')
        expect(delivery.message.type).toBe('event')
        expect(delivery.message.attributes).toEqual({ name: request.name })
        expect(delivery.message.body.startsWith(BACKGROUND_INSTRUCTION)).toBe(true)
        expect(delivery.message.body).toContain(request.instruction)
        expect(delivery.message.body).toContain('"subject":"Invoice"')
        expect(delivery.message.body).not.toContain(watch.id)
        const database = yield* Database
        const [row] = yield* database.run(
          database.select().from(threads).where(eq(threads.id, thread)),
        )
        expect(row).toMatchObject({ place: 'Background', title: request.name })
        expect((yield* (yield* ThreadStore).list(actor)).map((one) => one.id)).not.toContain(thread)
        const [arrival] = yield* database.run(
          database
            .select()
            .from(watchArrivals)
            .where(and(eq(watchArrivals.watchId, watch.id), eq(watchArrivals.eventId, 'evt_1'))),
        )
        expect(arrival).toMatchObject({ threadId: thread, runId: `run-watch:${watch.id}:evt_1` })
        // A second event is a second background Thread.
        yield* post(url, occurrence('evt_2'), secret, Option.none())
        expect(yield* deliveriesOf(watch.id)).toHaveLength(2)
        expect(threadOf(watch.id, 'evt_2')).not.toBe(thread)
      }).pipe(Effect.scoped),
    )

    it.effect('answers 404 for an unknown Watch and 410 once a Watch has stopped', () =>
      Effect.gen(function* () {
        const post = yield* receiver()
        const { actor, watch, url, secret } = yield* activeWatch()
        const unknown = url.replace(/[^/]+$/u, 'not-a-watch')
        const missing = yield* post(
          unknown,
          occurrence('evt_1'),
          secretFor((yield* ServerConfig).AUTH_SECRET, WatchId.make('not-a-watch')),
          Option.none(),
        )
        expect(missing).toEqual({ status: 404, text: '' })
        yield* (yield* Watches).stop(actor, request.name)
        const gone = yield* post(url, occurrence('evt_9'), secret, Option.none())
        expect(gone.status).toBe(410)
        expect(yield* deliveriesOf(watch.id)).toEqual([])
      }).pipe(Effect.scoped),
    )
  })
})
