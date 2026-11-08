import { OwedStore } from '../owed/store.ts'
import { describe, expect, layer } from '@effect/vitest'
import {
  CreateWatchRequest,
  WatchCondition,
  WatchIntent,
  CheckinFocus,
  CheckinTiming,
  WatchPurpose,
  CheckinArming,
  ThreadId,
  WatchState,
  ConnectionGrant,
  ConnectionState,
  RunState,
  SignalCue,
  RunOrigin,
  WatchId,
  ReviseWatchRequest,
} from '@vivid/contracts'
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
import { WatchedApps } from './apps.ts'
import { threadOf, watchRoutes } from './receiver.ts'
import { secretFor, sign } from './signature.ts'
import { WatchStore } from './store.ts'
import { RunStore, RunEnding } from '../threads/runs.ts'
import { Delivered, Executor, person, testLayer } from './testing.ts'
import { getRecord, readyGrant, saveState, recordChanged } from '../connections/records.ts'

const request = CreateWatchRequest.make({
  name: 'New mail in Work Mail',
  account: 'Mail (Work)',
  event: 'message.received',
  arguments: {},
  instruction: 'Tell me when a client writes.',
  condition: WatchCondition.cases.Continuous.make({}),
  purpose: WatchIntent.cases.Event.make({}),
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
const activeWatch = Effect.fn('WatchTest.activeWatch')(function* (
  condition: WatchCondition = WatchCondition.cases.Continuous.make({}),
  purpose: WatchIntent = WatchIntent.cases.Event.make({}),
) {
  const actor = yield* person()
  const executor = yield* Executor
  yield* Queue.offer(executor.answers, {
    id: `evs_${'3'.repeat(32)}`,
    refreshBefore: new Date(7 * 24 * 60 * 60_000),
  })
  const watch = yield* (yield* Watches).create(actor, { ...request, condition, purpose })
  const asked = yield* Queue.take(executor.subscribed)
  const secret = secretFor((yield* ServerConfig).AUTH_SECRET, watch.id)
  // The secret Executor was given is the one the receiver derives: the handshake depends on it.
  expect(asked.secret).toEqual(secret)
  return { actor, watch, url: asked.url, secret }
})

/** The receiver route, served in process with the test's own services and clock. */
const receiver = Effect.fn('WatchTest.receiver')(function* () {
  const context = yield* Effect.context<
    WatchStore | ThreadStore | Conversation | ServerConfig | Changes | Watches | WatchedApps
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

/** The real timer's payload carries the persisted operation key, independent of event delivery id. */
const timerEvent = (eventId: string, operationKey: string) =>
  JSON.stringify({
    eventId,
    name: 'mail.message.received',
    timestamp: '2026-10-29T09:00:00Z',
    data: { operationKey },
  })

describe.skipIf(!testDatabaseConfigured)('Watch receiver', () => {
  layer(testLayer)((it) => {
    it.effect(
      'keeps arming Awaiting until the actual matching receipt and ignores superseded timer events',
      () =>
        Effect.gen(function* () {
          const post = yield* receiver()
          const purpose = WatchIntent.cases.Checkin.make({
            focus: CheckinFocus.cases.OpenWork.make({}),
            timing: CheckinTiming.cases.Requested.make({
              request: 'Every morning',
              timezone: 'Africa/Lagos',
            }),
          })
          const { actor, watch, url, secret } = yield* activeWatch(
            WatchCondition.cases.Continuous.make({}),
            purpose,
          )
          if (!WatchPurpose.guards.Checkin(watch.purpose)) return expect.fail('Expected a check-in')
          expect(CheckinArming.guards.Awaiting(watch.purpose.arming)).toBe(true)
          const key = watch.purpose.arming.operationKey
          const found = yield* (yield* WatchStore).find(watch.id)
          if (Option.isNone(found)) return expect.fail('Expected the persisted Watch')
          const watching = yield* Watches
          expect(
            (yield* post(url, timerEvent('before-receipt', key), secret, Option.none())).status,
          ).toBe(503)
          const invalid = yield* Effect.flip(
            watching.confirmTimer(
              actor,
              found.value.connectionId,
              { operationKey: key },
              { nextAt: 1000 },
            ),
          )
          expect(invalid._tag).toBe('CheckinNotScheduled')
          const [awaiting] = yield* watching.list(actor)
          if (awaiting === undefined || !WatchPurpose.guards.Checkin(awaiting.purpose))
            return expect.fail('Expected an Awaiting check-in')
          expect(CheckinArming.guards.Awaiting(awaiting.purpose.arming)).toBe(true)
          yield* watching.confirmTimer(
            actor,
            found.value.connectionId,
            { operationKey: key },
            { operationKey: key, nextAt: 1000 },
          )
          expect(
            (yield* post(url, timerEvent('confirmed', key), secret, Option.none())).status,
          ).toBe(200)
          const delivered = yield* deliveriesOf(watch.id)
          expect(delivered).toHaveLength(1)
          expect(
            Option.map(Option.fromUndefinedOr(delivered[0]), (delivery) => delivery.origin),
          ).toEqual(
            Option.some(
              StoredRunOrigin.cases.Checkin.make({
                watchName: watch.name,
                watchId: watch.id,
                eventId: 'confirmed',
              }),
            ),
          )
          const updated = yield* watching.updateCheckin(
            actor,
            ReviseWatchRequest.cases.Timing.make({ name: watch.name, timing: purpose.timing }),
          )
          if (!WatchPurpose.guards.Checkin(updated.purpose))
            return expect.fail('Expected an updated check-in')
          expect(updated.purpose.arming.operationKey).not.toBe(key)
          expect(CheckinArming.guards.Awaiting(updated.purpose.arming)).toBe(true)
          yield* watching.confirmTimer(
            actor,
            found.value.connectionId,
            { operationKey: key },
            { operationKey: key, nextAt: 1000 },
          )
          expect(
            (yield* post(url, timerEvent('superseded', key), secret, Option.none())).status,
          ).toBe(200)
          expect(yield* deliveriesOf(watch.id)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'reads a resolved owed source at firing and completes its check-in with the admitted Run',
      () =>
        Effect.gen(function* () {
          const post = yield* receiver()
          const actor = yield* person()
          const source = yield* (yield* ThreadStore).create(actor, {
            id: ThreadId.make(crypto.randomUUID()),
            title: 'Invoice',
            projectId: null,
          })
          const owed = yield* OwedStore
          const record = yield* owed.track(actor, {
            threadId: source.id,
            what: 'Invoice',
            from: 'Client',
            since: 0,
            due: null,
            nextStep: 'Check for the invoice',
          })
          const executor = yield* Executor
          yield* Queue.offer(executor.answers, {
            id: 'owed-check',
            refreshBefore: new Date(604800000),
          })
          const watching = yield* Watches
          const watch = yield* watching.create(actor, {
            ...request,
            purpose: WatchIntent.cases.Checkin.make({
              focus: CheckinFocus.cases.Owed.make({ owedId: record.id }),
              timing: CheckinTiming.cases.Chosen.make({
                nextAt: 1000,
                why: 'Follow up on the invoice',
              }),
            }),
          })
          const subscribed = yield* Queue.take(executor.subscribed)
          if (!WatchPurpose.guards.Checkin(watch.purpose)) return expect.fail('Expected a check-in')
          const found = yield* (yield* WatchStore).find(watch.id)
          if (Option.isNone(found)) return expect.fail('Expected the persisted check-in')
          const operationKey = watch.purpose.arming.operationKey
          yield* watching.confirmTimer(
            actor,
            found.value.connectionId,
            { operationKey },
            { operationKey, nextAt: 1000 },
          )
          yield* owed.resolve(actor, {
            id: record.id,
            how: 'The invoice arrived in the original Thread.',
          })
          expect(
            (yield* post(
              subscribed.url,
              timerEvent('source-closed', operationKey),
              subscribed.secret,
              Option.none(),
            )).status,
          ).toBe(200)
          const completed = yield* (yield* WatchStore).find(watch.id)
          if (Option.isNone(completed)) return expect.fail('Expected completed history')
          if (!WatchState.guards.Completed(completed.value.watch.state))
            return expect.fail('Expected terminal completion')
          expect(completed.value.watch.state.evidence).toBe(
            'The invoice arrived in the original Thread.',
          )
          const [run] = yield* (yield* RunStore).list(threadOf(watch.id, 'source-closed'))
          if (run === undefined || !RunOrigin.guards.Checkin(run.origin))
            return expect.fail('Expected the admitted check-in Run')
          expect(completed.value.watch.state.runId).toBe(run.id)
          expect(run.origin.watchId).toBe(watch.id)
          expect(
            (yield* post(
              subscribed.url,
              timerEvent('after-closure', operationKey),
              subscribed.secret,
              Option.none(),
            )).status,
          ).toBe(410)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'only its admitted Run can complete an Until Watch and later callbacks answer 410',
      () =>
        Effect.gen(function* () {
          const post = yield* receiver()
          const { actor, watch, url, secret } = yield* activeWatch(
            WatchCondition.cases.Until.make({ condition: 'The invoice arrived.' }),
          )
          const watching = yield* Watches
          expect(
            (yield* Effect.flip(watching.complete(actor, watch.name, 'The invoice arrived.')))._tag,
          ).toBe('WatchRunRequired')
          expect((yield* post(url, event('invoice'), secret, Option.none())).status).toBe(200)
          const threadId = threadOf(watch.id, 'invoice')
          const [run] = yield* (yield* RunStore).list(threadId)
          if (run === undefined) return expect.fail('Expected the admitted Watch Run')
          const completed = yield* watching.complete(
            { ...actor, threadId: Option.some(threadId) },
            watch.name,
            'Read the invoice from the client.',
          )
          expect(completed.state).toEqual(
            WatchState.cases.Completed.make({
              at: 0,
              runId: run.id,
              evidence: 'Read the invoice from the client.',
            }),
          )
          expect(yield* watching.list(actor)).toEqual([])
          expect((yield* post(url, event('after-completion'), secret, Option.none())).status).toBe(
            410,
          )
          expect(yield* deliveriesOf(watch.id)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'acknowledges paused events without a Run and resubscribes after the same Connection is Ready',
      () =>
        Effect.gen(function* () {
          const post = yield* receiver()
          const { actor, watch, url, secret } = yield* activeWatch()
          const watching = yield* Watches
          const store = yield* WatchStore
          const found = yield* store.find(watch.id)
          if (Option.isNone(found)) return expect.fail('Expected the Watch')
          const connection = yield* getRecord(actor, found.value.connectionId, false)
          const paused = yield* saveState(
            connection,
            ConnectionState.cases.NeedsAuthorization.make({}),
            connection.references,
            ConnectionGrant.cases.ReauthorizationRequired.make({}),
          )
          yield* recordChanged(actor, paused)
          const [listed] = yield* watching.list(actor)
          expect(Option.map(Option.fromUndefinedOr(listed), (watch) => watch.state)).toEqual(
            Option.some(WatchState.cases.Paused.make({ at: 0, connectionId: connection.id })),
          )
          expect((yield* post(url, event('while-paused'), secret, Option.none())).status).toBe(200)
          expect(yield* deliveriesOf(watch.id)).toEqual([])
          const executor = yield* Executor
          yield* Queue.offer(executor.answers, {
            id: 'reconnected',
            refreshBefore: new Date(604800000),
          })
          const ready = yield* saveState(
            paused,
            ConnectionState.cases.Ready.make({}),
            paused.references,
            readyGrant(paused.references),
          )
          yield* recordChanged(actor, ready)
          expect((yield* Queue.take(executor.subscribed)).url).toBe(url)
          const [resumed] = yield* watching.list(actor)
          expect(Option.map(Option.fromUndefinedOr(resumed), (watch) => watch.state)).toEqual(
            Option.some(WatchState.cases.Active.make({ refreshBefore: 604800000 })),
          )
          expect((yield* post(url, event('after-reconnect'), secret, Option.none())).status).toBe(
            200,
          )
          expect(yield* deliveriesOf(watch.id)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )
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

    it.effect('keeps prior runs and ignores retired callbacks after a condition revision', () =>
      Effect.gen(function* () {
        const post = yield* receiver()
        const { actor, watch, url, secret } = yield* activeWatch()
        expect((yield* post(url, event('before-revision'), secret, Option.none())).status).toBe(200)
        const prior = yield* deliveriesOf(watch.id)
        yield* Queue.offer((yield* Executor).answers, {
          id: 'revised',
          refreshBefore: new Date(7 * 24 * 60 * 60_000),
        })
        const revised = yield* (yield* Watches).revise(
          actor,
          ReviseWatchRequest.cases.Filters.make({
            name: watch.name,
            arguments: { folder: 'important' },
            instruction: 'Summarize important mail.',
          }),
        )
        const subscribed = yield* Queue.take((yield* Executor).subscribed)
        expect(revised.id).toBe(watch.id)
        expect((yield* post(url, event('stale-subscription'), secret, Option.none())).status).toBe(
          200,
        )
        expect(yield* deliveriesOf(watch.id)).toEqual(prior)
        expect(
          (yield* post(subscribed.url, event('after-revision'), secret, Option.none())).status,
        ).toBe(200)
        const delivered = yield* deliveriesOf(watch.id)
        expect(delivered).toHaveLength(2)
        expect(delivered[0]).toEqual(prior[0])
        expect(JSON.stringify(delivered[1])).toContain(revised.instruction)
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
            condition: request.condition,
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
