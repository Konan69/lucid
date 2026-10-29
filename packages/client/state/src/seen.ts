import { VividRpcClient } from '@vivid/client-runtime'
import type { ThreadDetail, ThreadId } from '@vivid/contracts'
import { Effect, Exit, Result } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { LiveEngine, LiveFamily, LiveQuery, LiveResult } from './live.js'

/**
 * Marking a Thread read by looking at it, decided once for web, mobile and desktop.
 *
 * Both apps had their own copy. The browser's remembered fifty Threads; the phone's remembered
 * every Thread a session ever opened and never let one go. The policy is here now and each app
 * supplies only its live engine, its Thread queries and the way it starts a program.
 */

/**
 * How many Threads' last reported standing is remembered. It is the browser's former bound. A
 * Person looks at one Thread at a time and each look refreshes that Thread's place, so the one
 * on screen is never the one let go; fifty only has to cover moving back and forth between
 * recent Threads without reporting each again.
 */
const REMEMBERED = 50

/**
 * Which standing (`updatedAt`) of each Thread has been reported as read, for the most recently
 * looked-at `limit` Threads.
 *
 * It is a plain synchronous `Map`, not the installed `effect/Cache` (4.0.2), though that has a
 * `capacity`. A claim is made inside an atom's read, which must answer at once and is called
 * again for every reader and every recomputation; `Cache.get`, `Cache.set` and
 * `Cache.invalidate` each return an `Effect`, so every read would have to start a fiber only to
 * learn that nothing has changed. A `Cache` also owns a lookup per key and keeps its result,
 * where this needs a compare-and-claim on a number and a release when a report fails.
 */
const makeReadLedger = (limit: number) => {
  // Insertion order is recency: a claim moves its Thread to the end, so the first key is the
  // Thread looked at longest ago.
  const reported = new Map<ThreadId, number>()

  return {
    /**
     * Whether a Thread standing at `moved` still has to be reported. Saying yes remembers it at
     * once, so a burst of results for the same standing is reported once.
     *
     * Letting the oldest Thread go costs at most one repeated report if the Person opens it
     * again, which the server accepts. It never loses a report.
     */
    claim: (id: ThreadId, moved: number): boolean => {
      const last = reported.get(id)
      reported.delete(id)
      if (last !== undefined && last >= moved) {
        reported.set(id, last)
        return false
      }
      reported.set(id, moved)
      if (reported.size > limit) {
        const oldest = reported.keys().next()
        if (oldest.done !== true) reported.delete(oldest.value)
      }
      return true
    },
    /**
     * Takes a claim back because its report did not get through, so the next result tries again
     * instead of leaving read work marked unread. A newer claim made meanwhile is left alone:
     * that one has its own report on the way.
     */
    release: (id: ThreadId, moved: number): void => {
      if (reported.get(id) === moved) reported.delete(id)
    },
  }
}

/** What an app supplies: its live engine, its Thread queries and how it starts a program. */
export interface SeenThreadInput {
  readonly engine: Pick<LiveEngine, 'run'>
  readonly threads: LiveFamily<ThreadId, ThreadDetail>
  /**
   * Starts a described program on the app's runtime. This module only describes the work. What
   * an app's own starter hands back (a way to stop the program) is not used: a report is one
   * short call, and nothing ever calls it off.
   */
  readonly launch: (program: Effect.Effect<void>) => void
}

/**
 * Builds the query a Thread's screen reads while the Person is looking at it: the Thread's live
 * detail, which marks the Thread read each time it moves.
 *
 * Looking at a Thread is what marks it read, so that happens in the atom. It is an event on the
 * data, not something a component has to remember to do after it renders; when nobody is reading
 * the atom, nothing is reported.
 *
 * The Thread's own query stays subscribed for minutes after its screen closes, so coming back is
 * instant. This atom does not (idle time zero): it stops the moment nothing reads it, or a reply
 * that arrived after the Person left would be marked read without ever being seen. Each app
 * decides when its screen reads this one and when the Thread's plain query.
 */
export function makeSeenThread(input: SeenThreadInput) {
  const ledger = makeReadLedger(REMEMBERED)

  /**
   * One `MarkThreadRead`. `engine.run` puts a refusal in the value, so the claim is released on
   * a refusal and equally when the program dies or is interrupted: a claim left standing after a
   * report that never arrived would keep the Thread unread until it moved again.
   */
  const report = (id: ThreadId, moved: number) =>
    input.engine
      .run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          yield* client.MarkThreadRead({ id })
        }),
      )
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!(Exit.isSuccess(exit) && Result.isSuccess(exit.value))) ledger.release(id, moved)
          }),
        ),
        Effect.asVoid,
      )

  /** Tells the server a Thread was looked at as it now stands, once for each time it moves. */
  const markSeen = (id: ThreadId, result: LiveResult<ThreadDetail>) => {
    if (!AsyncResult.isSuccess(result)) return
    const moved = result.value.thread.updatedAt
    if (ledger.claim(id, moved)) input.launch(report(id, moved))
  }

  // One watched query for each Thread's own query, for as long as that one exists.
  const seenQueries = new WeakMap<LiveQuery<ThreadDetail>, LiveQuery<ThreadDetail>>()

  return (id: ThreadId): LiveQuery<ThreadDetail> => {
    const base = input.threads.get(id)
    const existing = seenQueries.get(base)
    if (existing !== undefined) return existing
    const watched: LiveQuery<ThreadDetail> = {
      expect: base.expect,
      atom: Atom.setIdleTTL(
        Atom.readable((get) => {
          const result = get(base.atom)
          markSeen(id, result)
          return result
        }),
        0,
      ),
    }
    seenQueries.set(base, watched)
    return watched
  }
}
