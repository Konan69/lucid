import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { Changes, type Topic } from './changes.ts'

/**
 * Turns a read into a live query: the current result now, then again each time it changes.
 *
 * This is the whole of Vivid's realtime model. A `Watch…` call is its `List…`/`Get…` loader handed
 * to this function with the topics the loader depends on. The loader runs once on subscription and
 * again whenever one of those topics moves; a result structurally equal to the previous one is
 * dropped, so a client redraws only when what it shows is different.
 *
 * Ordering matters. The subscription to the change bus is opened before the first load, so a write
 * that lands between the load and the subscription is not lost: it queues, and the loader runs
 * again. Bursts are coalesced for a few milliseconds so that a transaction touching ten rows
 * causes one reload, not ten. A reload that is overtaken by a newer change is abandoned.
 */
export const watch = <A, E, R>(
  topics: ReadonlyArray<Topic>,
  load: Effect.Effect<A, E, R>,
): Stream.Stream<A, E, R | Changes> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* Changes
      const moved = yield* changes.subscribe(topics)
      return Stream.concat(Stream.make(undefined), Stream.debounce(moved, '20 millis')).pipe(
        Stream.switchMap(() => Stream.fromEffect(load)),
        Stream.changes,
      )
    }),
  )
