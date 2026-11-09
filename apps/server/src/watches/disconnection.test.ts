import { unansweredOperations } from '../connections/testing.ts'
import { describe, expect, layer } from '@effect/vitest'
import {
  ConnectionId,
  CreateWatchRequest,
  WatchCondition,
  WatchIntent,
  ServiceId,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Fiber, Layer, Option, Queue, Ref } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import {
  Executor as ConnectionExecutor,
  ExecutorAppId,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { removeConnection } from '../connections/migration.ts'
import { decodeRow, encodeReferences, listRecords } from '../connections/records.ts'
import { connections } from '../connections/tables.ts'
import { ServerConfig } from '../config.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import type { Actor } from '../auth/access.ts'
import type { Changes } from '../live/changes.ts'
import type { Conversation } from '../threads/conversation.ts'
import type { ThreadStore } from '../threads/store.ts'
import { RunStore } from '../threads/runs.ts'
import { ExecutorEvents, ExecutorEventsUnreachable } from './events.ts'
import { Watches } from './lifecycle.ts'
import { WatchedApps } from './apps.ts'
import { threadOf, watchRoutes } from './receiver.ts'
import { secretFor, sign } from './signature.ts'
import { WatchStore } from './store.ts'
import { Executor, person, testLayer } from './testing.ts'

/** The real removal path receives a ready dedicated Connection, as Settings supplies it. */
const connect = Effect.fn('WatchDisconnectTest.connect')(function* (actor: Actor) {
  const database = yield* Database
  const id = ConnectionId.make(crypto.randomUUID())
  const app = ExecutorAppId.make(`app-${id}`)
  const references = ExecutorReferences.cases.Public.make({
    service: ServiceId.make('mail'),
    app,
    owner: ExecutorOwnerId.make(`owner-${actor.person.id}`),
    binding: ExecutorBinding.cases.Public.make({}),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
  })
  const rows = yield* database.run(
    database
      .insert(connections)
      .values({
        id,
        personId: actor.person.id,
        companyId: null,
        service: references.service,
        serviceName: 'Mail',
        name: 'Work',
        executorApp: app,
        references: yield* encodeReferences(references),
        status: 'ready',
        createdAt: 0,
        updatedAt: 0,
      })
      .returning(),
  )
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})

describe.skipIf(!testDatabaseConfigured)('Watch disconnection', () => {
  layer(testLayer)((it) => {
    it.effect(
      'deletes Watches on Integration removal, unsubscribes and rejects signed deliveries',
      () =>
        Effect.gen(function* () {
          const actor = yield* person()
          const connection = yield* connect(actor)
          const executor = yield* Executor
          const before = (yield* Ref.get(executor.unsubscribed)).length
          yield* Queue.offer(executor.answers, {
            id: `evs_${'7'.repeat(32)}`,
            refreshBefore: new Date(7 * 24 * 60 * 60_000),
          })
          const watch = yield* (yield* Watches).create(
            actor,
            CreateWatchRequest.make({
              name: 'Disconnected mail',
              account: 'Mail (Work)',
              event: 'message.received',
              arguments: {},
              instruction: 'Tell me when a client writes.',
              condition: WatchCondition.cases.Continuous.make({}),
              purpose: WatchIntent.cases.Event.make({}),
            }),
          )
          yield* Queue.take(executor.subscribed)
          const events = yield* ExecutorEvents
          const removal = yield* Layer.build(
            Layer.mock(ConnectionExecutor, {
              as: () => ({ ...unansweredOperations, remove: () => Effect.void }),
            }),
          )
          yield* removeConnection(connection).pipe(
            Effect.provideContext(removal),
            Effect.provideService(ExecutorEvents, {
              ...events,
              unsubscribe: (caller, subscription) =>
                events
                  .unsubscribe(caller, subscription)
                  .pipe(Effect.andThen(Effect.fail(new ExecutorEventsUnreachable({})))),
            }),
          )
          const found = yield* (yield* WatchStore).find(watch.id)
          expect(Option.isNone(found)).toBe(true)
          expect((yield* Ref.get(executor.unsubscribed)).slice(before)).toEqual([
            'mail.message.received',
          ])
          expect(yield* listRecords(actor)).toEqual([])
          const config = yield* ServerConfig
          const context = yield* Effect.context<
            WatchStore | ServerConfig | Changes | Conversation | ThreadStore | Watches | WatchedApps
          >()
          const web = yield* Effect.acquireRelease(
            Effect.sync(() =>
              HttpRouter.toWebHandler(
                watchRoutes.pipe(Layer.provideMerge(Layer.succeedContext(context))),
                { disableLogger: true },
              ),
            ),
            (handler) => Effect.promise(() => handler.dispose()),
          )
          const body = JSON.stringify({
            eventId: 'after-removal',
            name: 'mail.message.received',
            timestamp: '2026-10-24T00:00:00Z',
            data: {},
          })
          const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
          const id = 'msg_disconnected'
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request(`${config.PUBLIC_URL.href.replace(/\/$/u, '')}/api/watches/${watch.id}`, {
                method: 'POST',
                body,
                headers: {
                  'webhook-id': id,
                  'webhook-timestamp': timestamp,
                  'webhook-signature': sign(secretFor(config.AUTH_SECRET, watch.id), {
                    id,
                    timestamp,
                    body,
                  }),
                },
              }),
            ),
          )
          expect(response.status).toBe(410)
          const forged = yield* Effect.promise(() =>
            web.handler(
              new Request(`${config.PUBLIC_URL.href.replace(/\/$/u, '')}/api/watches/${watch.id}`, {
                method: 'POST',
                body,
                headers: {
                  'webhook-id': id,
                  'webhook-timestamp': timestamp,
                  'webhook-signature': 'v1,AAAA',
                },
              }),
            ),
          )
          expect([401, 404]).toContain(forged.status)
          expect(yield* (yield* RunStore).list(threadOf(watch.id, 'after-removal'))).toEqual([])
          const database = yield* Database
          expect(
            yield* database.run(
              database.select().from(connections).where(eq(connections.id, connection.id)),
            ),
          ).toHaveLength(0)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'keeps the Connection identity when account ordinals shift and the account is renamed',
      () =>
        Effect.gen(function* () {
          const actor = yield* person()
          const first = yield* connect(actor)
          const second = yield* connect(actor)
          const database = yield* Database
          yield* database.run(
            database.update(connections).set({ name: null }).where(eq(connections.id, first.id)),
          )
          const executor = yield* Executor
          yield* Queue.offer(executor.answers, {
            id: 'evs_ordinal',
            refreshBefore: new Date(604800000),
          })
          const watching = yield* Watches
          const watch = yield* watching.create(
            actor,
            CreateWatchRequest.make({
              name: 'Second mail',
              account: 'Mail (Work)',
              event: 'message.received',
              arguments: {},
              instruction: 'Tell me when a client writes.',
              condition: WatchCondition.cases.Continuous.make({}),
              purpose: WatchIntent.cases.Event.make({}),
            }),
          )
          yield* Queue.take(executor.subscribed)
          yield* database.run(
            database
              .update(connections)
              .set({ name: null, createdAt: 1 })
              .where(eq(connections.id, second.id)),
          )
          expect((yield* watching.list(actor)).map((one) => one.account)).toEqual(['Mail (2)'])
          const removal = yield* Layer.build(
            Layer.mock(ConnectionExecutor, {
              as: () => ({ ...unansweredOperations, remove: () => Effect.void }),
            }),
          )
          yield* removeConnection(first).pipe(Effect.provideContext(removal))
          expect((yield* watching.list(actor)).map((one) => one.account)).toEqual(['Mail'])
          yield* database.run(
            database
              .update(connections)
              .set({ name: 'Personal' })
              .where(eq(connections.id, second.id)),
          )
          expect((yield* watching.list(actor)).map((one) => one.account)).toEqual([
            'Mail (Personal)',
          ])
          const found = yield* (yield* WatchStore).find(watch.id)
          expect(found).toMatchObject({ value: { connectionId: second.id } })
        }).pipe(Effect.scoped),
    )

    it.effect(
      'reports an Integration removed while a Pending Watch awaits its subscription grant',
      () =>
        Effect.gen(function* () {
          const actor = yield* person()
          const connection = yield* connect(actor)
          const executor = yield* Executor
          const creating = yield* Effect.forkChild(
            (yield* Watches).create(
              actor,
              CreateWatchRequest.make({
                name: 'Pending mail',
                account: 'Mail (Work)',
                event: 'message.received',
                arguments: {},
                instruction: 'Tell me when a client writes.',
                condition: WatchCondition.cases.Continuous.make({}),
                purpose: WatchIntent.cases.Event.make({}),
              }),
            ),
          )
          const subscription = yield* Queue.take(executor.subscribed)
          const removal = yield* Layer.build(
            Layer.mock(ConnectionExecutor, {
              as: () => ({ ...unansweredOperations, remove: () => Effect.void }),
            }),
          )
          yield* removeConnection(connection).pipe(Effect.provideContext(removal))
          expect(yield* (yield* Watches).list(actor)).toEqual([])
          yield* Queue.offer(executor.answers, {
            id: 'evs_late',
            refreshBefore: new Date(604800000),
          })
          expect((yield* Effect.flip(Fiber.join(creating)))._tag).toBe('WatchConnectionRemoved')
          expect(yield* Ref.get(executor.unsubscribed)).toContain(subscription.name)
        }).pipe(Effect.scoped),
    )
  })
})
