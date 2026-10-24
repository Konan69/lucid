import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, CreateWatchRequest, ServiceId } from '@vivid/contracts'
import { Effect, Layer, Option, Queue, Ref, Result } from 'effect'
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
import type { Actor } from '../auth/access.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes } from '../live/changes.ts'
import { WatchedApps, WatchConnectionRemoved } from './apps.ts'
import { ExecutorEvents } from './events.ts'
import { Watches, watchesLayer } from './lifecycle.ts'
import { ServerConfig } from '../config.ts'
import { WatchStore, watchStoreLayer } from './store.ts'
import { Executor, person, testLayer } from './testing.ts'

const request = CreateWatchRequest.make({
  name: 'Mail during removal',
  account: 'Mail (Work)',
  event: 'message.received',
  arguments: {},
  instruction: 'Tell me when a client writes.',
})

/** Own the persisted fixture so reversal against main still reaches each removal assertion. */
const connect = Effect.fn('WatchSnapshotTest.connect')(function* (actor: Actor) {
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

/** Keep SQL real; pause after the first read so a separate client can commit removal. */
const afterRead = (database: Database['Service'], after: Effect.Effect<void>) =>
  Database.of({
    _: database._,
    query: database.query,
    $with: database.$with,
    $cache: database.$cache,
    $count: database.$count.bind(database),
    with: database.with.bind(database),
    select: database.select.bind(database),
    selectDistinct: database.selectDistinct.bind(database),
    selectDistinctOn: database.selectDistinctOn.bind(database),
    insert: database.insert.bind(database),
    update: database.update.bind(database),
    delete: database.delete.bind(database),
    refreshMaterializedView: database.refreshMaterializedView.bind(database),
    execute: database.execute.bind(database),
    transaction: (operation) => database.transaction(operation),
    run: (query) => database.run(query).pipe(Effect.tap(() => after)),
  })

describe.skipIf(!testDatabaseConfigured)('Watch presentation during removal', () => {
  layer(testLayer)((it) => {
    for (const selection of ['list', 'named'] as const) {
      it.effect(`${selection} names Watches from the same snapshot when removal commits`, () =>
        Effect.gen(function* () {
          const actor = yield* person()
          const connection = yield* connect(actor)
          const executor = yield* Executor
          yield* Queue.offer(executor.answers, {
            id: 'evs_snapshot',
            refreshBefore: new Date(604800000),
          })
          const watch = yield* (yield* Watches).create(actor, request)
          yield* Queue.take(executor.subscribed)
          const writerContext = yield* Layer.build(Layer.fresh(testDatabaseLayer))
          const writer = yield* Database.pipe(Effect.provideContext(writerContext))
          const removalContext = yield* Layer.build(
            Layer.mock(ConnectionExecutor, { remove: () => Effect.void }),
          )
          const pending = yield* Ref.make(true)
          const events = yield* ExecutorEvents
          const remove = Effect.gen(function* () {
            if (!(yield* Ref.getAndSet(pending, false))) return
            yield* removeConnection(connection).pipe(
              Effect.provideContext(removalContext),
              Effect.provideService(Database, writer),
              Effect.provideService(ExecutorEvents, events),
            )
          }).pipe(Effect.catch(() => Effect.sync(() => expect.fail('Concurrent removal failed'))))
          const database = yield* Database
          const context = yield* Layer.build(
            Layer.fresh(
              watchStoreLayer.pipe(
                Layer.provide(Layer.succeed(Database, afterRead(database, remove))),
              ),
            ),
          )
          const store = yield* WatchStore.pipe(Effect.provideContext(context))
          const read =
            selection === 'list'
              ? store.list(actor)
              : store.named(actor, request.name).pipe(Effect.map(Option.toArray))
          const outcome = yield* Effect.result(
            read.pipe(Effect.map((records) => records.map((record) => record.watch))),
          )
          expect(outcome).toEqual(Result.succeed([watch]))
          expect(yield* store.list(actor)).toEqual([])
          expect(yield* listRecords(actor)).toEqual([])
        }).pipe(Effect.scoped),
      )
    }

    it.effect('reports removal after activation before returning the granted Watch', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const connection = yield* connect(actor)
        const removalContext = yield* Layer.build(
          Layer.mock(ConnectionExecutor, { remove: () => Effect.void }),
        )
        const changes = yield* Changes
        const context = yield* Effect.context<
          WatchStore | WatchedApps | ExecutorEvents | Changes | ServerConfig | Database
        >()
        const watched = yield* Layer.build(
          Layer.fresh(
            watchesLayer.pipe(
              Layer.provide(
                Layer.succeed(Changes, {
                  ...changes,
                  publish: () =>
                    removeConnection(connection).pipe(
                      Effect.provideContext(removalContext),
                      Effect.provideContext(context),
                      Effect.catch(() =>
                        Effect.sync(() => expect.fail('Post-activation removal failed')),
                      ),
                    ),
                }),
              ),
              Layer.provide(Layer.succeedContext(context)),
            ),
          ),
        )
        const watching = yield* Watches.pipe(Effect.provideContext(watched))
        const executor = yield* Executor
        yield* Queue.offer(executor.answers, {
          id: 'evs_removed_after_activation',
          refreshBefore: new Date(604800000),
        })
        const outcome = yield* Effect.result(watching.create(actor, request))
        expect(outcome).toEqual(
          Result.fail(new WatchConnectionRemoved({ connectionId: connection.id })),
        )
        yield* Queue.take(executor.subscribed)
        expect(yield* listRecords(actor)).toEqual([])
      }).pipe(Effect.scoped),
    )
  })
})
