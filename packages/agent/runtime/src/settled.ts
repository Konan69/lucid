import type { EntryId, Harness, SubmissionRecord } from '@earendil-works/pi-durable'
import { Array as Arr, Deferred, Effect, Order, Queue, type Scope } from 'effect'
import { release } from './deliveries.ts'
import { recordResponse } from './response.ts'

type Settled = SubmissionRecord & { readonly type: 'input' }
type Placed = Settled & { readonly entry: EntryId }

const isSettled = (record: SubmissionRecord): record is Settled =>
  record.type === 'input' && (record.status === 'done' || record.status === 'unanswered')
const isPlaced = (record: Settled): record is Placed => record.entry !== undefined

/** Pi's ids ascend in the order submissions were admitted. */
const oldestFirst = Order.mapInput(Order.Number, (record: Placed) => record.id)

/** The inputs one commit settled, and when. */
interface Batch {
  readonly settled: ReadonlyArray<Settled>
  readonly at: number
}
/** A marker in the queue: reaching it means everything queued before it is done. */
interface Barrier {
  readonly reached: Deferred.Deferred<void>
}

/**
 * What follows every settlement, exactly once per delivery however its response ended: a final
 * answer, a tool that ended the turn, a model failure, a stop, or a withdrawal while still queued.
 *
 * A generation hook misses failed or stopped runs. Every ending shares the commit that
 * settles the run's inputs (`endRun`, Pi `src/harness/live.ts`, settles all of them in one
 * commit), and a Session publishes each commit to its listeners (`subscribeCommits`). So this
 * reads settlements from the commits themselves:
 *
 * - each settled delivery's kept record is released (the frozen context, `deliveries.ts`);
 * - the inputs that were placed and settled together are one run, and its metadata entry is
 *   appended (`response.ts`).
 *
 * A listener may not call the Session, so it only queues what it saw and one fiber does the
 * work in order. `quiet` waits until everything queued before it has been done (it queues a
 * marker and waits for the fiber to reach it).
 * None of this is durable: what a kill or a late settlement during close leaves is under "Known
 * limits" in this package's `AGENTS.md`.
 */
export const followSettlements: (
  harness: Harness,
) => Effect.Effect<{ readonly quiet: Effect.Effect<void> }, never, Scope.Scope> = Effect.fn(
  'Settled.follow',
)(function* (harness: Harness) {
  const work = yield* Queue.unbounded<Batch | Barrier>()
  const unsubscribe = harness.subscribeCommits((publication) => {
    const settled = publication.changes.flatMap((change) =>
      change.type === 'submission' && isSettled(change.value) ? [change.value] : [],
    )
    if (settled.length > 0) Queue.offerUnsafe(work, { settled, at: Date.now() })
  })
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

  const handle = Effect.fn('Settled.handle')(function* (batch: Batch) {
    for (const record of batch.settled) {
      if (record.requestId !== undefined)
        yield* release(harness, record.conversationId, record.requestId)
    }
    const conversations = new Set(batch.settled.map((record) => record.conversationId))
    for (const conversationId of conversations) {
      const inputs = Arr.sort(
        batch.settled.filter((record) => record.conversationId === conversationId).filter(isPlaced),
        oldestFirst,
      )
      yield* recordResponse(harness, { conversationId, inputs, finishedAt: batch.at })
    }
  })

  yield* Queue.take(work).pipe(
    Effect.flatMap((item) =>
      'reached' in item
        ? Deferred.succeed(item.reached, undefined)
        : // One batch's failure must not end the following of every later settlement.
          handle(item).pipe(
            Effect.catchTag('PiRejected', () =>
              Effect.logWarning('A settlement\u2019s follow-up writes were not all made'),
            ),
          ),
    ),
    Effect.forever,
    Effect.forkScoped,
  )
  return {
    quiet: Effect.gen(function* () {
      const reached = yield* Deferred.make<void>()
      yield* Queue.offer(work, { reached })
      yield* Deferred.await(reached)
    }),
  }
})
