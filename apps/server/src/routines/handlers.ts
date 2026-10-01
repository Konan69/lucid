import * as Effect from 'effect/Effect'
import {
  NotFound,
  Conflict,
  InvalidRequest,
  OccurrenceResponse,
  RoutineListResponse,
  RoutineResponse,
  type RoutineId,
  type CreateRoutineRequest,
  type PatchRoutineRequest,
  type RoutineParams,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { THREAD_OPENING_FAILURE } from './attempts.ts'
import { RoutineScheduler } from './scheduler.ts'
import { RoutineStore, type RoutineMissing } from './store.ts'
import type { InvalidRoutineSchedule } from './timing.ts'

/** Internal validation failures become the fixed public RPC errors without exposing ownership. */
const missing = () => new NotFound({ message: 'Routine not found' })
const webhookRequired = () => new InvalidRequest({ message: 'Routine must use a webhook trigger' })
const invalidSchedule = (error: InvalidRoutineSchedule) =>
  new InvalidRequest({ message: error.message })

/** List and Watch use one owner-scoped loader, including when the live workspace changes. */
const loadRoutines = Effect.fn('Rpc.loadRoutines')(function* (actor: Actor) {
  return RoutineListResponse.make({ routines: yield* (yield* RoutineStore).list(actor) })
})

/** Resolves the store's concealed absence into the shared transport failure. */
const concealMissing = <A, E, R>(effect: Effect.Effect<A, E | RoutineMissing, R>) =>
  effect.pipe(Effect.catchTag('RoutineMissing', () => Effect.fail(missing())))

export const routineHandlers = {
  /** Both a Person and Vivid acting for them see precisely their own Routines. */
  ListRoutines: Effect.fn('Rpc.ListRoutines')(function* () {
    return yield* loadRoutines(yield* requireActor())
  }),
  /** Live reads reuse the loader and follow the signed-in Person’s current workspace. */
  WatchRoutines: () => live(loadRoutines),
  /** The store validates the trigger and schedules atomically with the creation. */
  CreateRoutine: Effect.fn('Rpc.CreateRoutine')(function* (
    request: typeof CreateRoutineRequest.Type,
  ) {
    const actor = yield* requireActor()
    const routine = yield* concealMissing((yield* RoutineStore).create(actor, request)).pipe(
      Effect.catchTag('InvalidRoutineSchedule', (error) => Effect.fail(invalidSchedule(error))),
    )
    yield* changed(actor)
    return RoutineResponse.make({ routine })
  }),
  /** Owner authorization and concurrent partial update semantics belong to persistence. */
  PatchRoutine: Effect.fn('Rpc.PatchRoutine')(function* ({
    id,
    patch,
  }: {
    readonly id: RoutineId
    readonly patch: typeof PatchRoutineRequest.Type
  }) {
    const actor = yield* requireActor()
    const routine = yield* concealMissing((yield* RoutineStore).patch(actor, id, patch)).pipe(
      Effect.catchTag('InvalidRoutineSchedule', (error) => Effect.fail(invalidSchedule(error))),
    )
    yield* changed(actor)
    return RoutineResponse.make({ routine })
  }),
  /** Successful deletion refreshes every live view of the owner's workspace. */
  DeleteRoutine: Effect.fn('Rpc.DeleteRoutine')(function* ({ id }: typeof RoutineParams.Type) {
    const actor = yield* requireActor()
    yield* concealMissing((yield* RoutineStore).remove(actor, id))
    yield* changed(actor)
  }),
  /** Manual work uses the same delivery ordering as scheduled and webhook work. */
  RunRoutine: Effect.fn('Rpc.RunRoutine')(function* ({ id }: typeof RoutineParams.Type) {
    const actor = yield* requireActor()
    const run = yield* concealMissing((yield* RoutineScheduler).run(actor, id)).pipe(
      Effect.catchTag('RoutineThreadUnavailable', () =>
        Effect.fail(new Conflict({ message: THREAD_OPENING_FAILURE })),
      ),
    )
    yield* changed(actor)
    return OccurrenceResponse.make({ run })
  }),
  /** Rotation returns a redacted key once and invalidates the previous credential. */
  IssueRoutineWebhook: Effect.fn('Rpc.IssueRoutineWebhook')(function* ({
    id,
  }: {
    readonly id: RoutineId
  }) {
    const actor = yield* requireActor()
    const webhook = yield* concealMissing((yield* RoutineStore).issueWebhook(actor, id)).pipe(
      Effect.catchTag('RoutineWebhookRequired', () => Effect.fail(webhookRequired())),
    )
    yield* changed(actor)
    return webhook
  }),
}
