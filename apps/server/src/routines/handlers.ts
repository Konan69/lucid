import * as Effect from 'effect/Effect'
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
    if (routine === undefined)
      return yield* Effect.fail(new Conflict({ message: 'Routine could not be created' }))
    return RoutineResponse.make({ routine })
  }),
  PatchRoutine: Effect.fn('Rpc.PatchRoutine')(function* ({ id, patch }) {
    const store = yield* RoutineStore
    const current = yield* store.get(id)
    if (current === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    const scheduler = yield* RoutineScheduler
    yield* scheduler
      .validate(patch.cron ?? current.cron, patch.timezone ?? current.timezone)
      .pipe(Effect.mapError(invalidRequest))
    const routine = yield* store.patch(id, patch)
    if (routine === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    yield* scheduler.schedule(routine).pipe(Effect.mapError(invalidRequest))
    return RoutineResponse.make({ routine: (yield* store.get(id)) ?? routine })
  }),
  DeleteRoutine: Effect.fn('Rpc.DeleteRoutine')(function* ({ id }) {
    const store = yield* RoutineStore
    if (!(yield* store.remove(id)))
      return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
  }),
  RunRoutine: Effect.fn('Rpc.RunRoutine')(function* ({ id }) {
    const scheduler = yield* RoutineScheduler
    const run = yield* scheduler.run(id)
    if (run === undefined) return yield* Effect.fail(new NotFound({ message: 'Routine not found' }))
    return OccurrenceResponse.make({ run })
  }),
}
