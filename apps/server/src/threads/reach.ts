import { Deferred, Effect, Fiber, Result, Stream } from 'effect'
import type { PersonId, SessionId } from '@vivid/contracts'
import { sessionWorkspace } from '../auth/session.ts'
import { Topic } from '../live/changes.ts'
import { sessionRanOut, watch } from '../live/query.ts'
import { untraced } from '../observability/quiet.ts'
import { requireThread, type StoredThread } from './access.ts'

/**
 * Rechecks both authorities together so the first upstream pull cannot outrun either check.
 * `watch` subscribes before loading; the readiness receipt is issued only after that first load
 * succeeds. A removal between the handler's check and body consumption is therefore caught
 * before a buffered runtime event is exposed. Subsequent removals and silent expiry stop the
 * open body, and its scope releases the watcher on disconnect or finite-body completion.
 */
export const authorized = <A, E, R>(
  source: Stream.Stream<A, E, R>,
  thread: StoredThread,
  authority: { readonly personId: PersonId; readonly sessionId: SessionId },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { personId, sessionId } = authority
      const topics = [Topic.thread(thread.id), Topic.person(personId)]
      const ready = yield* Deferred.make<void>()
      const checked = sessionWorkspace(personId, sessionId).pipe(
        Effect.andThen(requireThread(thread.id, personId)),
        Effect.andThen(Deferred.succeed(ready, undefined)),
        Effect.asVoid,
        // Re-run on every topic move while the conversation stream is open; see `untraced`.
        untraced,
      )
      const removed = watch(
        'Session',
        thread.companyId === null ? topics : [...topics, Topic.company(thread.companyId)],
        // The session and whether the Thread may still be seen: a turn's own activity moves neither.
        [],
        checked,
      ).pipe(Stream.runDrain)
      const ended = yield* Effect.raceFirst(removed, sessionRanOut(personId, sessionId)).pipe(
        Effect.forkScoped,
      )
      // Failure before readiness ends the already-started body without pulling any upstream bytes.
      const initial = yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(ended)).pipe(
        Effect.result,
      )
      if (Result.isFailure(initial)) return Stream.empty
      return Stream.interruptWhen(source, Fiber.join(ended).pipe(Effect.catch(() => Effect.void)))
    }),
  )
