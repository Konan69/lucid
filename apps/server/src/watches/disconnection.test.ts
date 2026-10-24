import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, CreateWatchRequest, ServiceId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Layer, Option, Queue, Ref } from 'effect'
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
import { Watches } from './lifecycle.ts'
import { watchRoutes } from './receiver.ts'
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
      'stops Watches on Integration removal, unsubscribes and rejects signed deliveries',
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
            }),
          )
          yield* Queue.take(executor.subscribed)
          yield* removeConnection(connection).pipe(
            Effect.provide(
              Layer.mock(ConnectionExecutor, {
                remove: () => Effect.void,
              }),
            ),
          )
          const found = yield* (yield* WatchStore).find(watch.id)
          expect(Option.map(found, (record) => record.watch.state)).toEqual(
            Option.some({ _tag: 'Stopped', reason: 'disconnected' }),
          )
          expect((yield* Ref.get(executor.unsubscribed)).slice(before)).toEqual([
            'mail.message.received',
          ])
          expect(yield* listRecords(actor)).toEqual([])
          const config = yield* ServerConfig
          const context = yield* Effect.context<
            WatchStore | ServerConfig | Changes | Conversation | ThreadStore
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
          const database = yield* Database
          expect(
            yield* database.run(
              database.select().from(connections).where(eq(connections.id, connection.id)),
            ),
          ).toHaveLength(1)
        }).pipe(Effect.scoped),
    )
  })
})
