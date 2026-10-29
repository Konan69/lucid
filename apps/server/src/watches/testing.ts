import { RuntimeSubmissionId } from '@vivid/contracts'
import { expect } from '@effect/vitest'
import {
  Person,
  PersonId,
  ConnectionId,
  ServiceId,
  type RunId,
  Workspace,
  type WatchArguments,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Option, Queue, Ref, type Redacted } from 'effect'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { ServerConfig } from '../config.ts'
import { testConfigLayer, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Conversation, type Delivery } from '../threads/conversation.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { WatchedApps, watchedAppsLayer } from './apps.ts'
import { ExecutorEvents, type EventDefinition, type ExecutorEventsFailure } from './events.ts'
import { conversationLayer as realConversationLayer } from '../threads/delivery.ts'
import { RunStore, runStoreLayer } from '../threads/runs.ts'
import { Runtime, Admission } from '../runtime/client.ts'
import { deliveryRunId } from '../threads/key.ts'
import { ThreadTitles } from '../threads/generation.ts'
import { Presence } from '../threads/presence.ts'
import { Notifier } from '../notifications/notifier.ts'
import { silentChannelRepliesLayer } from '../channels/replies.ts'
import {
  Executor as ConnectionExecutor,
  ExecutorAppId,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { connections } from '../connections/tables.ts'
import { encodeReferences } from '../connections/records.ts'
import { watchesLayer } from './lifecycle.ts'
import { owedStoreLayer } from '../owed/store.ts'
import { watchStoreLayer } from './store.ts'

/**
 * Watch test seams. PostgreSQL, the Watch store and the Thread store are always the real ones;
 * what stands in is what lies outside this server (Executor, and the runtime behind
 * Conversation). Connection resolution and SQL admission use production code.
 */

/** A failed cleanup fails the test rather than leaving the Person's rows behind. */
const cleanup = (database: Database['Service'], id: PersonId) =>
  database
    .run(database.delete(personTable).where(eq(personTable.id, id)))
    .pipe(Effect.catch(cleanupFailed))
const cleanupFailed = () => Effect.sync(() => expect.fail('Watch fixture cleanup failed'))

/** A Person of their own for each test, removed with everything they own when the test ends. */
export const person = Effect.fn('WatchTest.person')(function* () {
  const database = yield* Database
  const owner = Person.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Watch owner',
    email: `${crypto.randomUUID()}@watch.test`,
    image: null,
  })
  yield* Effect.addFinalizer(() => cleanup(database, owner.id))
  yield* database.run(database.insert(personTable).values(owner))
  return {
    person: owner,
    workspace: Workspace.cases.Personal.make({}),
    by: 'vivid',
    threadId: Option.none(),
  } satisfies Actor
})

/** Every delivery the receiver made, in order. */
export class Delivered extends Context.Service<Delivered, Ref.Ref<ReadonlyArray<Delivery>>>()(
  'test/WatchDelivered',
) {}

/**
 * Use production Conversation and RunStore. Only the external runtime and observers unrelated
 * to background Watches stand in. Repeated deliveries must reach the real SQL admission logic.
 */
export const conversationLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database
    const config = yield* ServerConfig
    const store = yield* RunStore
    const delivered = yield* Ref.make<ReadonlyArray<Delivery>>([])
    const admitted = yield* Ref.make<ReadonlyArray<RunId>>([])
    const runtime = Layer.mock(Runtime, {
      admit: Effect.fn('WatchTest.admit')(function* (input) {
        const runId = deliveryRunId(input.threadId, input.idempotencyKey)
        expect(
          yield* Ref.get(admitted),
          'A retry must not reach runtime admission twice',
        ).not.toContain(runId)
        yield* Ref.update(admitted, (all) => [...all, runId])
        return Admission.make({
          runId,
          submissionId: RuntimeSubmissionId.make(input.turn),
          repeated: false,
        })
      }),
      settled: () => Effect.never,
    })
    const context = yield* Layer.build(
      realConversationLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database, database),
            Layer.succeed(ServerConfig, config),
            Layer.succeed(RunStore, store),
            threadStoreLayer.pipe(Layer.provide(Layer.succeed(Database, database))),
            runtime,
            silentChangesLayer,
            silentChannelRepliesLayer,
            Layer.mock(ThreadTitles, { afterRun: () => Effect.void }),
            Layer.mock(Presence, { watching: () => Effect.succeed(false) }),
            Layer.mock(Notifier, { notify: () => Effect.void }),
          ),
        ),
      ),
    )
    const real = yield* Conversation.pipe(Effect.provideContext(context))
    const conversation = Conversation.of({
      ...real,
      deliver: (delivery) =>
        Ref.update(delivered, (all) => [...all, delivery]).pipe(
          Effect.andThen(real.deliver(delivery)),
        ),
    })
    return Context.make(Conversation, conversation).pipe(Context.add(Delivered, delivered))
  }),
)

/** One call Executor received, and the answer the test gives it. */
export type Subscribed = {
  readonly name: string
  readonly arguments: WatchArguments
  readonly url: string
  readonly secret: Redacted.Redacted
}

/** A subscription Executor granted. */
export type Grant = { readonly id: string; readonly refreshBefore: Date }

/**
 * What the stand-in Executor answers subscribe with: a grant, a failure, or a grant Vivid never
 * hears of. `lost` records the grant at Executor and then never answers, as when Vivid's process
 * dies, or its request is interrupted, after Executor subscribed and before the Watch was activated.
 */
export type Answer = Grant | ExecutorEventsFailure | { readonly lost: Grant }

/** The calls made to the stand-in Executor and the answers it gives, controlled by the test. */
export interface ExecutorControl {
  readonly subscribed: Queue.Queue<Subscribed>
  readonly answers: Queue.Queue<Answer>
  readonly unsubscribed: Ref.Ref<ReadonlyArray<string>>
  /** The id of each grant Executor made that Vivid never heard of, as it makes it. */
  readonly lost: Queue.Queue<string>
}
export class Executor extends Context.Service<Executor, ExecutorControl>()('test/WatchExecutor') {}

/** An app with slug `mail` declaring `message.received`, filtered by folder. */
export const definitions: ReadonlyArray<EventDefinition> = [
  {
    name: 'mail.message.received',
    description: 'A message arrived.',
    inputSchema: { properties: { folder: { type: 'string' } } },
  },
  { name: 'other.thing', description: 'Another app.', inputSchema: {} },
]

/**
 * Executor answered by the test. Subscribe offers what it was asked, then waits for the test's
 * answer, a grant or a failure: the window in which the real Executor POSTs its challenge.
 */
export const executorLayer = Layer.effectContext(
  Effect.gen(function* () {
    const subscribed = yield* Queue.unbounded<Subscribed>()
    const answers = yield* Queue.unbounded<Answer>()
    const unsubscribed = yield* Ref.make<ReadonlyArray<string>>([])
    const lost = yield* Queue.unbounded<string>()
    const events = ExecutorEvents.of({
      list: Effect.succeed(definitions),
      subscribe: Effect.fn('Test.Executor.subscribe')(function* (input) {
        yield* Queue.offer(subscribed, input)
        const answer = yield* Queue.take(answers)
        if ('lost' in answer) {
          yield* Queue.offer(lost, answer.lost.id)
          return yield* Effect.never
        }
        return 'refreshBefore' in answer ? answer : yield* answer
      }),
      unsubscribe: (input) => Ref.update(unsubscribed, (previous) => [...previous, input.name]),
    })
    return Context.make(ExecutorEvents, events).pipe(
      Context.add(Executor, { subscribed, answers, unsubscribed, lost }),
    )
  }),
)

/** Create the fixture's dedicated account only when a Watch first asks for it. */
const fixtureConnection = Effect.fn('WatchTest.fixtureConnection')(function* (actor: Actor) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(connections).where(eq(connections.personId, actor.person.id)).limit(1),
  )
  if (rows.length > 0) return
  const id = ConnectionId.make(crypto.randomUUID())
  const app = ExecutorAppId.make(`app-${id}`)
  const references = ExecutorReferences.cases.Public.make({
    service: ServiceId.make('mail'),
    app,
    owner: ExecutorOwnerId.make(`owner-${actor.person.id}`),
    binding: ExecutorBinding.cases.Public.make({}),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
  })
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: 'Mail',
      name: 'Work',
      executorApp: app,
      references: yield* encodeReferences(references),
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }),
  )
})

/** Resolve real Connection rows and names; only the foreign app slug stands in. */
export const appsLayer = Layer.effect(
  WatchedApps,
  Effect.gen(function* () {
    const database = yield* Database
    const context = yield* Layer.build(
      watchedAppsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database, database),
            Layer.mock(ConnectionExecutor, { appSlug: () => Effect.succeed('mail') }),
          ),
        ),
      ),
    )
    const apps = yield* WatchedApps.pipe(Effect.provideContext(context))
    return WatchedApps.of({
      ...apps,
      appOf: (actor, account) =>
        fixtureConnection(actor).pipe(
          Effect.andThen(apps.appOf(actor, account)),
          Effect.provideService(Database, database),
        ),
    })
  }),
)

/**
 * Everything a Watch test runs on: the real stores on the disposable database, the real Watches
 * service and server configuration, and the stand-ins above.
 */
export const testLayer = watchesLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      watchStoreLayer,
      owedStoreLayer,
      threadStoreLayer,
      appsLayer,
      executorLayer,
      conversationLayer,
      silentChangesLayer,
    ),
  ),
  Layer.provideMerge(
    runStoreLayer.pipe(Layer.provideMerge(Layer.mergeAll(testDatabaseLayer, testConfigLayer))),
  ),
)
