import { expect } from '@effect/vitest'
import {
  Person,
  PersonId,
  Run,
  RunId,
  RunOrigin,
  RunState,
  Workspace,
  type WatchArguments,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Option, Queue, Ref, type Redacted } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import type { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer, type Changes } from '../live/changes.ts'
import { Conversation, type Delivery } from '../threads/conversation.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { WatchedApps } from './apps.ts'
import { ExecutorEvents, type EventDefinition, type ExecutorEventsFailure } from './events.ts'
import { watchesLayer } from './lifecycle.ts'
import { watchRoutes } from './receiver.ts'
import { sign } from './signature.ts'
import { WatchStore, watchStoreLayer } from './store.ts'

/**
 * Watch test seams. PostgreSQL, the Watch store and the Thread store are always the real ones;
 * what stands in is what lies outside this server (Executor, and the runtime behind
 * Conversation) and the Connection store, which another change is rewriting.
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
 * Conversation as the runtime's caller sees it: one Run per idempotency key, whatever the number
 * of calls, which is the guarantee the receiver relies on for redeliveries.
 */
export const conversationLayer = Layer.effectContext(
  Effect.gen(function* () {
    const delivered = yield* Ref.make<ReadonlyArray<Delivery>>([])
    const conversation = Conversation.of({
      admit: () => Effect.die('Watches never admit through the gateway'),
      deliver: Effect.fn('Test.WatchConversation.deliver')(function* (delivery) {
        yield* Ref.update(delivered, (previous) => [...previous, delivery])
        return Run.make({
          id: RunId.make(`run-${delivery.idempotencyKey}`),
          threadId: delivery.threadId,
          turn: 1,
          origin: RunOrigin.cases.Watch.make({
            person: { id: delivery.personId, name: 'Watch owner', image: null },
            watchName: 'test',
          }),
          state: RunState.cases.Working.make({}),
          startedAt: 0,
        })
      }),
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

/** What the stand-in Executor answers subscribe with: a grant, or a failure. */
export type Answer = { readonly id: string; readonly refreshBefore: Date } | ExecutorEventsFailure

/** The calls made to the stand-in Executor and the answers it gives, controlled by the test. */
export interface ExecutorControl {
  readonly subscribed: Queue.Queue<Subscribed>
  readonly answers: Queue.Queue<Answer>
  readonly unsubscribed: Ref.Ref<ReadonlyArray<string>>
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
    const events = ExecutorEvents.of({
      list: Effect.succeed(definitions),
      subscribe: Effect.fn('Test.Executor.subscribe')(function* (input) {
        yield* Queue.offer(subscribed, input)
        const answer = yield* Queue.take(answers)
        return 'refreshBefore' in answer ? answer : yield* answer
      }),
      unsubscribe: (input) => Ref.update(unsubscribed, (previous) => [...previous, input.name]),
    })
    return Context.make(ExecutorEvents, events).pipe(
      Context.add(Executor, { subscribed, answers, unsubscribed }),
    )
  }),
)

/** The Person has one ready account, "Mail (Work)", on the `mail` app. */
export const appsLayer = Layer.succeed(
  WatchedApps,
  WatchedApps.of({
    appOf: (_actor, account) =>
      account.toLowerCase() === 'mail (work)'
        ? Effect.succeed({ account: 'Mail (Work)', appSlug: 'mail' })
        : Effect.die(`Unexpected account ${account}`),
    accountsOf: () => Effect.succeed(['Mail (Work)']),
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
      threadStoreLayer,
      appsLayer,
      executorLayer,
      conversationLayer,
      silentChangesLayer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(testDatabaseLayer, testConfigLayer)),
)

/** The receiver route, served in process with the test's own services and clock. */
export const receiver = Effect.fn('WatchTest.receiver')(function* () {
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
