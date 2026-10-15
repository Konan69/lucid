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
import { Context, Effect, Layer, Option, Queue, Ref, type Redacted } from 'effect'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Conversation, type Delivery } from '../threads/conversation.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { WatchedApps } from './apps.ts'
import { ExecutorEvents, type EventDefinition, type ExecutorEventsFailure } from './events.ts'
import { watchesLayer } from './lifecycle.ts'
import { watchStoreLayer } from './store.ts'

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
