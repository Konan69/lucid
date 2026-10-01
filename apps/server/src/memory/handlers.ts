import {
  AuditEvent,
  type Forbidden,
  InvalidRequest,
  MemoryListResponse,
  MemoryResponse,
  NotFound,
  RecallResponse,
  ServiceUnavailable,
  type CorrectMemoryRequest,
  type Memory,
  type MemoryId,
  type RecallRequest,
  type RememberRequest,
} from '@vivid/contracts'
import { Effect, Match } from 'effect'
import { Audit } from '../audit/record.ts'
import { requireActor, requirePerson, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { MemoryAccess, type MemoryAccessFailure } from './store.js'

/** Keep provider delay in logs, and expose only the fixed RPC failure vocabulary on the wire. */
export const memoryFailure = Effect.fn('Memory.publicFailure')(
  (failure: MemoryAccessFailure | Forbidden) =>
    Match.value(failure).pipe(
      Match.tag(
        'Forbidden',
        'NotFound',
        'InvalidRequest',
        'DatabaseUnavailable',
        'DatabaseConstraintViolation',
        'DatabaseFailure',
        (error) => Effect.fail(error),
      ),
      Match.tag('ServiceUnavailable', (error) =>
        Effect.gen(function* () {
          if ('retryAfter' in error)
            yield* Effect.logWarning('Memory rate limited', {
              tag: error._tag,
              retryAfter: error.retryAfter,
            })
          return yield* Effect.fail(
            ServiceUnavailable.make({ service: 'memory', message: error.message }),
          )
        }),
      ),
      Match.tag('MemoryNotFound', () =>
        Effect.fail(NotFound.make({ message: 'Memory not found' })),
      ),
      Match.tag('InvalidMemoryLimit', () =>
        Effect.fail(
          InvalidRequest.make({ message: 'Memory limit must be an integer from 1 to 100' }),
        ),
      ),
      Match.orElse((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning('Memory operation unavailable', { tag: error._tag })
          return yield* Effect.fail(
            ServiceUnavailable.make({
              service: 'memory',
              message: `Memory operation failed (${error._tag})`,
            }),
          )
        }),
      ),
    ),
)

/** List and Watch use the same Person loader; the brief is derived from the same authorized memory set. */
const loadMemory = Effect.fn('Memory.load')(
  function* (actor: Actor) {
    const access = yield* MemoryAccess
    return MemoryListResponse.make({
      memories: [...(yield* access.list(actor))],
      brief: yield* access.brief(actor),
    })
  },
  (effect) => effect.pipe(Effect.catch(memoryFailure)),
)

/** Audit carries scope only; publishing follows a successful write even if the audit adapter fails afterward. */
const memorySaved = Effect.fn('Memory.saved')(function* (actor: Actor, memory: Memory) {
  yield* changed(actor)
  yield* (yield* Audit).record(
    actor,
    AuditEvent.cases.MemorySaved.make({ scope: memory.scope._tag }),
  )
  return MemoryResponse.make({ memory })
})

export const memoryHandlers = {
  /** A Person's list follows their notes across workspaces and includes only readable shared knowledge. */
  ListMemory: Effect.fn('Rpc.ListMemory')(function* () {
    yield* requirePerson()
    return yield* loadMemory(yield* requireActor())
  }),
  /** Foundation live queries re-authorize workspace membership on every invalidation. */
  WatchMemory: () => live(loadMemory),
  /** Vivid's shared-room page is constructed without consulting any persisted personal brief. */
  GetMemoryBrief: Effect.fn('Rpc.GetMemoryBrief')(
    function* () {
      return yield* (yield* MemoryAccess).brief(yield* requireActor())
    },
    (effect) => effect.pipe(Effect.catch(memoryFailure)),
  ),
  /** Cross-partition results are merged by hybrid score before applying the caller's result limit. */
  Recall: Effect.fn('Rpc.Recall')(
    function* (input: RecallRequest) {
      const memories = yield* (yield* MemoryAccess).recall(yield* requireActor(), {
        query: input.query,
        limit: input.limit === undefined ? 12 : input.limit,
      })
      return RecallResponse.make({ memories: [...memories] })
    },
    (effect) => effect.pipe(Effect.catch(memoryFailure)),
  ),
  /** Explicit Company intent and Thread audience determine the only permitted destination. */
  Remember: Effect.fn('Rpc.Remember')(
    function* (input: RememberRequest) {
      const actor = yield* requireActor()
      const memory = yield* (yield* MemoryAccess).remember(actor, input)
      return yield* memorySaved(actor, memory)
    },
    (effect) => effect.pipe(Effect.catch(memoryFailure)),
  ),
  /** A correction shares the ownership gate used by forgetting and creates a new latest version. */
  CorrectMemory: Effect.fn('Rpc.CorrectMemory')(
    function* (input: CorrectMemoryRequest) {
      const actor = yield* requireActor()
      const memory = yield* (yield* MemoryAccess).correct(actor, input)
      return yield* memorySaved(actor, memory)
    },
    (effect) => effect.pipe(Effect.catch(memoryFailure)),
  ),
  /** A rejected id produces NotFound without auditing or invalidating another Person's knowledge. */
  ForgetMemory: Effect.fn('Rpc.ForgetMemory')(
    function* ({ id }: { readonly id: MemoryId }) {
      const actor = yield* requireActor()
      const memory = yield* (yield* MemoryAccess).forget(actor, id)
      yield* changed(actor)
      yield* (yield* Audit).record(
        actor,
        AuditEvent.cases.MemoryForgotten.make({ scope: memory.scope._tag }),
      )
    },
    (effect) => effect.pipe(Effect.catch(memoryFailure)),
  ),
}
