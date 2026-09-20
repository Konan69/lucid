import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  Conflict,
  NotFound,
  OccurrenceResponse,
  RoutineListResponse,
  RoutineResponse,
} from '@vivid/contracts'
import { invalidRequest } from '../rpc/failures.ts'
import { RoutineScheduler } from './scheduler.ts'
import { RoutineStore } from './store.ts'

export const routineHandlers = {
  ListRoutines: Effect.fn('Rpc.ListRoutines')(function* () {
    const store = yield* RoutineStore
    return RoutineListResponse.make({ routines: yield* store.list() })
  }),
  CreateRoutine: Effect.fn('Rpc.CreateRoutine')(function* (request) {
    const scheduler = yield* RoutineScheduler
    yield* scheduler.validate(request.cron, request.timezone).pipe(Effect.mapError(invalidRequest))
    const store = yield* RoutineStore
    const created = yield* store.create(request)
    yield* scheduler.schedule(created).pipe(Effect.mapError(invalidRequest))
    const routine = yield* store.get(created.id)
    if (Option.isNone(routine))
      return yield* Effect.fail(new Conflict({ message: 'Routine could not be created' }))
    return RoutineResponse.make({ routine: routine.value })
  }),
  PatchRoutine: Effect.fn('Rpc.PatchRoutine')(function* ({ id, patch }) {
    const store = yield* RoutineStore
    const current = yield* store.get(id)
    if (Option.isNone(current))
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    const scheduler = yield* RoutineScheduler
    yield* scheduler
      .validate(patch.cron ?? current.value.cron, patch.timezone ?? current.value.timezone)
      .pipe(Effect.mapError(invalidRequest))
    const routine = yield* store.patch(id, patch)
    if (Option.isNone(routine))
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    yield* scheduler.schedule(routine.value).pipe(Effect.mapError(invalidRequest))
    const scheduled = yield* store.get(id)
    return RoutineResponse.make({
      routine: Option.isNone(scheduled) ? routine.value : scheduled.value,
    })
  }),
  DeleteRoutine: Effect.fn('Rpc.DeleteRoutine')(function* ({ id }) {
    const store = yield* RoutineStore
    if (!(yield* store.remove(id)))
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    return yield* Effect.void
  }),
  RunRoutine: Effect.fn('Rpc.RunRoutine')(function* ({ id }) {
    const scheduler = yield* RoutineScheduler
    const run = yield* scheduler.run(id)
    if (Option.isNone(run))
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    return OccurrenceResponse.make({ run: run.value })
  }),
}
