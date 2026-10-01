import { PgClient } from '@effect/sql-pg/PgClient'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type { CompanyId, PersonId, ThreadId } from '@vivid/contracts'
import { companyOf, type Actor } from '../auth/access.ts'

/**
 * What changed, coarsely: everything a Person owns, everything a Company holds, or one Thread.
 *
 * Topics are deliberately wide. A write does not say which query it affects; it says whose data
 * moved, every live query watching that owner runs again, and a result identical to the last one
 * is not sent (`live/query.ts`). That keeps "did I remember to invalidate it" out of every
 * handler: a handler names the owner it wrote for and is done.
 */
export type Topic = `p:${string}` | `c:${string}` | `t:${string}`

export const Topic = {
  person: (id: PersonId): Topic => `p:${id}`,
  company: (id: CompanyId): Topic => `c:${id}`,
  thread: (id: ThreadId): Topic => `t:${id}`,
}

/** The topics an Actor's own writes touch: themselves, and their Company when they are in one. */
export const topicsOf = (actor: Pick<Actor, 'person' | 'workspace'>): ReadonlyArray<Topic> => [
  Topic.person(actor.person.id),
  ...Option.match(companyOf(actor.workspace), {
    onNone: () => [],
    onSome: (company) => [Topic.company(company.id)],
  }),
]

export interface ChangesService {
  /** Says these owners' data moved. Never fails the write that already happened. */
  readonly publish: (topics: ReadonlyArray<Topic>) => Effect.Effect<void>
  /**
   * A stream with one element each time any of these topics moves. The subscription is live from
   * the moment this effect returns, so a caller that subscribes and then reads cannot miss a write
   * made between the two.
   */
  readonly subscribe: (
    topics: ReadonlyArray<Topic>,
  ) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

/**
 * The change bus behind every live query.
 *
 * PostgreSQL `LISTEN`/`NOTIFY` carries it, on one channel, because the writers are not all in this
 * process: the Routine and follow-up schedulers, a second server instance and a migration all
 * change data that an open client must hear about. Each process holds one listening connection
 * and fans notifications out to its own subscribers through an in-memory hub.
 *
 * A notification names topics and carries no data, so nothing private crosses the channel.
 */
export class Changes extends Context.Service<Changes, ChangesService>()('vivid/Changes') {}

const CHANNEL = 'vivid_changes'
const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/** Whether a notification names any topic a subscriber asked for. */
const touches = (wanted: ReadonlySet<string>) => (moved: ReadonlyArray<string>) =>
  moved.some((topic) => topic === EVERYTHING || wanted.has(topic))

/** The topic that touches every subscriber. Only the listener publishes it, when it reconnects. */
const EVERYTHING = '*'

const notificationNotSent = () => Effect.logWarning('A change notification could not be sent')

const makeChanges = Effect.fn('Changes.make')(function* () {
  const sql = yield* PgClient
  const hub = yield* PubSub.unbounded<ReadonlyArray<string>>()

  const forward = (payload: string) =>
    decodeTopics(payload).pipe(
      Effect.flatMap((topics) => PubSub.publish(hub, topics)),
      Effect.catch(() => Effect.logWarning('Ignored a malformed change notification')),
    )

  /**
   * One listening connection, held for as long as it lasts. Each time it is (re)established every
   * subscriber is told to reload (`EVERYTHING`): whatever was written while nothing was listening
   * was never announced, and a reload is the only way to be sure a screen is not showing the past.
   */
  const listen = Effect.gen(function* () {
    const notifications = yield* sql.listen(CHANNEL)
    yield* PubSub.publish(hub, [EVERYTHING])
    yield* Stream.runForEach(Stream.fromQueue(notifications), (notification) =>
      forward(notification.payload),
    )
  }).pipe(Effect.scoped)

  // The listener is supervised for the life of the server: a dropped connection is logged and
  // re-opened, never left dead with every live query quietly going stale.
  yield* listen.pipe(
    Effect.catch(() => Effect.logWarning('The change listener lost its connection; reconnecting')),
    Effect.repeat(Schedule.spaced('2 seconds')),
    Effect.forkScoped,
  )

  const publish = Effect.fn('Changes.publish')(function* (topics: ReadonlyArray<Topic>) {
    if (topics.length === 0) return
    // The write is already committed. If the notification cannot be sent, open clients miss one
    // refresh; failing the caller would instead report a successful write as a failure.
    yield* sql.notify(CHANNEL, JSON.stringify(topics)).pipe(Effect.catch(notificationNotSent))
  })

  const subscribe = Effect.fn('Changes.subscribe')(function* (topics: ReadonlyArray<Topic>) {
    const wanted = new Set<string>(topics)
    const subscription = yield* PubSub.subscribe(hub)
    return Stream.fromSubscription(subscription).pipe(
      Stream.filter(touches(wanted)),
      Stream.map(() => undefined),
    )
  })

  return Changes.of({ publish, subscribe })
})

export const changesLayer = Layer.effect(Changes, makeChanges())

/** A bus that carries nothing, for tests of logic that publishes but is not about publishing. */
export const silentChangesLayer = Layer.succeed(
  Changes,
  Changes.of({
    publish: () => Effect.void,
    subscribe: () => Effect.succeed(Stream.never),
  }),
)

/** Says the Actor's own data moved. The common case for a handler that just wrote. */
export const changed = Effect.fn('Changes.changed')(function* (
  actor: Pick<Actor, 'person' | 'workspace'>,
  ...more: ReadonlyArray<Topic>
) {
  const changes = yield* Changes
  yield* changes.publish([...topicsOf(actor), ...more])
})
