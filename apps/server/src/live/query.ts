import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { Forbidden } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { sessionWorkspace } from '../auth/session.ts'
import { Changes, Topic, topicsOf } from './changes.ts'

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

/**
 * A `Watch…` handler for the calling Person: `load` for whoever they are and wherever they are
 * working, kept current.
 *
 * Two things can change under an open subscription, and both are handled here so no handler has
 * to think about them. The data can change, which `watch` covers. And the Actor can change: the
 * Person switches workspace, is removed from the Company they were looking at, or signs out
 * somewhere else.
 *
 * The Actor is therefore never remembered. It is resolved from the session again before every
 * single load, so a result is always computed for who the Person is now: a removed Member's next
 * reload is a personal-space result, and a revoked session's next reload fails and ends the
 * stream. The Actor is also a live query of its own on the Person's topic, which is what
 * re-subscribes the inner query to the right Company's changes when the workspace moves.
 *
 * `also` adds topics beyond the Actor's own, for a query about one Thread.
 */
export const live = <A, E, R>(
  load: (actor: Actor) => Effect.Effect<A, E, R>,
  also: ReadonlyArray<Topic> = [],
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const auth = yield* AuthContext
      if (!AuthState.$is('Person')(auth)) {
        return yield* Effect.fail(new Forbidden({ message: 'Only a signed-in Person can watch' }))
      }
      const actor = sessionWorkspace(auth.person.id, auth.sessionId).pipe(
        Effect.map((workspace): Actor => ({
          person: auth.person,
          workspace,
          by: 'person',
          threadId: Option.none(),
        })),
      )
      const current = Effect.flatMap(actor, load)
      return watch([Topic.person(auth.person.id)], actor).pipe(
        Stream.switchMap((seen) => watch([...topicsOf(seen), ...also], current)),
        Stream.changes,
      )
    }),
  )
