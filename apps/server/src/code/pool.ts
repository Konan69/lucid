import * as NodeCrypto from 'node:crypto'
import type { CodeOutcome, PersonId } from '@vivid/contracts'
import { Deferred, Effect, Equal, Fiber, Hash, Option, RcMap, Semaphore } from 'effect'
import { budgets } from './budgets.ts'
import type { DisplayProgram, Dispatch } from './process.ts'

/** Equality excludes adapter closures but includes every part of execution authority and input. */
class Execution implements Equal.Equal {
  readonly key: string
  /** Hash exact source bytes and keep Person, Thread, summary and stored intent in the identity. */
  constructor(
    readonly input: DisplayProgram,
    readonly dispatch: Dispatch,
  ) {
    const hash = NodeCrypto.createHash('sha256')
      .update(JSON.stringify(input.request.code))
      .digest('hex')
    this.key = JSON.stringify([
      input.boundary.thread,
      input.boundary.person,
      hash,
      input.kind,
      input.request.summary,
    ])
  }
  /** Different readers and policies can never share data or execution. */
  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof Execution && this.key === other.key
  }
  /** RcMap uses the same identity for lookup and equality. */
  [Hash.symbol](): number {
    return Hash.string(this.key)
  }
}

interface PersonPool {
  readonly active: Set<Deferred.Deferred<void>>
  readonly waiting: Array<Deferred.Deferred<void>>
}

/** Synchronously hand the released slot to the oldest ticket before any new arrival can take it. */
function release(pool: PersonPool, ticket: Deferred.Deferred<void>) {
  if (pool.active.delete(ticket)) {
    const next = pool.waiting.shift()
    if (next !== undefined) {
      pool.active.add(next)
      Deferred.succeedUnsafe(next, undefined)
    }
    return
  }
  const position = pool.waiting.indexOf(ticket)
  if (position !== -1) pool.waiting.splice(position, 1)
}

/** Each scoped reference owns the shared fiber. Only the last departure closes it and its permit. */
export const makeDisplayPool = Effect.fn('Code.makeDisplayPool')(function* (
  execute: (input: DisplayProgram, dispatch: Dispatch) => Effect.Effect<CodeOutcome>,
  busy: CodeOutcome,
) {
  const server = yield* Semaphore.make(budgets.displays)
  const people = new Map<PersonId, PersonPool>()
  /** Count distinct programs, not their render waiters; four FIFO draws may wait behind two runs. */
  const lease = (person: PersonId) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const pool = people.get(person) ?? {
          active: new Set<Deferred.Deferred<void>>(),
          waiting: [],
        }
        if (pool.waiting.length >= budgets.queuedDisplays)
          return Option.none<{
            readonly pool: PersonPool
            readonly ticket: Deferred.Deferred<void>
          }>()
        const ticket = Deferred.makeUnsafe<void>()
        if (pool.active.size < budgets.personDisplays) {
          pool.active.add(ticket)
          Deferred.succeedUnsafe(ticket, undefined)
        } else pool.waiting.push(ticket)
        people.set(person, pool)
        return Option.some({ pool, ticket })
      }),
      (leased) =>
        Effect.sync(() => {
          if (Option.isNone(leased)) return
          const { pool, ticket } = leased.value
          release(pool, ticket)
          if (pool.active.size === 0 && pool.waiting.length === 0) people.delete(person)
        }),
    )
  // RcMap keeps in-flight resources until the last caller leaves. Zero idle TTL forbids replaying
  // completed writes. Its scope is independent of whichever render arrived first (Effect 4 RcMap).
  const executions = yield* RcMap.make({
    capacity: budgets.pendingDisplays,
    lookup: Effect.fn('Code.acquireDisplay')(function* ({ input, dispatch }: Execution) {
      const pool = yield* lease(input.boundary.person)
      if (Option.isNone(pool)) return yield* Effect.forkScoped(Effect.succeed(busy))
      const work = Deferred.await(pool.value.ticket).pipe(
        Effect.andThen(server.withPermits(1)(execute(input, dispatch))),
      )
      return yield* Effect.forkScoped(work)
    }),
  })
  return Effect.fn('Code.pooledDisplay')(
    function* (input: DisplayProgram, dispatch: Dispatch) {
      const fiber = yield* RcMap.get(executions, new Execution(input, dispatch))
      return yield* Fiber.join(fiber)
    },
    Effect.scoped,
    Effect.catchTag('ExceededCapacityError', () => Effect.succeed(busy)),
  )
})
