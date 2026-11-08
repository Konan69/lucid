import { describe, expect, layer } from '@effect/vitest'
import { CreateWatchRequest, RunState, SignalCue, WatchId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Layer, Option, Queue, Ref, type Redacted } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import type { Changes } from '../live/changes.ts'
import { DeliveryMessage, StoredRunOrigin, type Conversation } from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { Watches } from './lifecycle.ts'
import { threadOf, watchRoutes } from './receiver.ts'
import { secretFor, sign } from './signature.ts'
import type { WatchStore } from './store.ts'
import { RunStore, RunEnding } from '../threads/runs.ts'
import { Delivered, Executor, person, testLayer } from './testing.ts'

const request = CreateWatchRequest.make({
  name: 'New mail in Work Mail',
  account: 'Mail (Work)',
  event: 'message.received',
  arguments: {},
  instruction: 'Tell me when a client writes.',
})
const event = (eventId: string) =>
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

/** The receiver route, served in process with the test's own services and clock. */
const receiver = Effect.fn('WatchTest.receiver')(function* () {
  const context = yield* Effect.context<
    WatchStore | ThreadStore | Conversation | ServerConfig | Changes
  >()
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(watchRoutes.pipe(Layer.provideMerge(Layer.succeedContext(context))), {
        disableLogger: true,
      }),
    ),
    (handler) => Effect.promise(() => handler.dispose()),
  )
  /**
   * POST a body to a Watch's callback, signed as Executor signs it now on the test clock, or with
   * the given signature header to test a forgery.
   */
  return Effect.fn('WatchTest.post')(function* (
    url: string,
    body: string,
    secret: Redacted.Redacted,
    forged: Option.Option<string>,
  ) {
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    const id = 'msg_test'
    const signature = Option.getOrElse(forged, () => sign(secret, { id, timestamp, body }))
    const response = yield* Effect.promise(() =>
      web.handler(
        new Request(url, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            'webhook-id': id,
            'webhook-timestamp': timestamp,
            'webhook-signature': signature,
          },
        }),
      ),
    )
    return { status: response.status, text: yield* Effect.promise(() => response.text()) }
  })
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
        const first = yield* post(url, event('evt_1'), secret, Option.none())
        expect(first.status).toBe(200)
        const repeat = yield* post(url, event('evt_1'), secret, Option.none())
        expect(repeat.status).toBe(200)
        const delivered = yield* deliveriesOf(watch.id)
        // Each retry reaches Conversation; its durable receipt owns deduplication.
        expect(delivered).toHaveLength(2)
        const delivery = delivered[0]
        if (delivery === undefined) return expect.fail('Expected one delivery')
        const thread = threadOf(watch.id, 'evt_1')
        expect(delivery).toMatchObject({
          threadId: thread,
          personId: actor.person.id,
          idempotencyKey: `watch:${watch.id}:evt_1`,
        })
        expect(delivery.origin).toEqual(
          StoredRunOrigin.cases.Watch.make({
            watchId: watch.id,
            watchName: request.name,
            eventId: 'evt_1',
            event: request.event,
            occurredAt: '2026-10-15T20:00:00.000Z',
          }),
        )
        if (!DeliveryMessage.guards.Signal(delivery.message)) expect.fail('Expected a Signal')
        // The event reaches the runtime whole and typed; the runtime words it for the model.
        expect(delivery.message.cue).toEqual(
          SignalCue.cases.Watch.make({
            name: request.name,
            event: request.event,
            occurredAt: '2026-10-15T20:00:00.000Z',
            instruction: request.instruction,
            data: { from: 'client@example.com', subject: 'Invoice' },
          }),
        )
        const database = yield* Database
        const [row] = yield* database.run(
          database.select().from(threads).where(eq(threads.id, thread)),
        )
        expect(row).toMatchObject({ place: 'Background', title: request.name })
        expect((yield* (yield* ThreadStore).list(actor)).map((one) => one.id)).not.toContain(thread)
        const runs = yield* RunStore
        const working = yield* runs.list(thread)
        expect(working).toHaveLength(1)
        const run = working[0]
        if (run === undefined) return expect.fail('Expected one Run')
        yield* runs.end(run.id, RunEnding.cases.Completed.make({ responseId: run.id }))
        expect((yield* post(url, event('evt_1'), secret, Option.none())).status).toBe(200)
        const finished = yield* runs.list(thread)
        expect(finished).toHaveLength(1)
        const completed = finished[0]
        if (completed === undefined) return expect.fail('Expected the original Run')
        expect(completed.id).toBe(run.id)
        expect(RunState.guards.Completed(completed.state)).toBe(true)
        // A second event is a second background Thread.
        yield* post(url, event('evt_2'), secret, Option.none())
        expect(yield* deliveriesOf(watch.id)).toHaveLength(4)
        expect(threadOf(watch.id, 'evt_2')).not.toBe(thread)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'answers 401 for a forged unknown Watch and 410 for a signed unknown or stopped Watch',
      () =>
        Effect.gen(function* () {
          const post = yield* receiver()
          const { actor, watch, url, secret } = yield* activeWatch()
          const unknown = url.replace(/[^/]+$/u, 'not-a-watch')
          const missing = yield* post(
            unknown,
            event('evt_1'),
            secretFor((yield* ServerConfig).AUTH_SECRET, WatchId.make('not-a-watch')),
            Option.some('v1,AAAA'),
          )
          expect(missing).toEqual({ status: 401, text: '' })
          const removed = yield* post(
            unknown,
            event('evt_1'),
            secretFor((yield* ServerConfig).AUTH_SECRET, WatchId.make('not-a-watch')),
            Option.none(),
          )
          expect(removed.status).toBe(410)
          yield* (yield* Watches).stop(actor, request.name)
          const gone = yield* post(url, event('evt_9'), secret, Option.none())
          expect(gone.status).toBe(410)
          expect(yield* deliveriesOf(watch.id)).toEqual([])
        }).pipe(Effect.scoped),
    )
  })
})
