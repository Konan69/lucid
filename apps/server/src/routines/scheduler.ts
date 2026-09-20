import { Cron } from 'croner'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { Thread as ThreadSchema, Occurrence, type Routine, type RoutineId } from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import { Runtime } from '../runtime/client.ts'
import { ThreadStore } from '../threads/store.ts'
import { RoutineStore } from './store.ts'

const ROUTINE_TICK_MS = 20_000

export class InvalidRoutineSchedule extends Schema.TaggedError<InvalidRoutineSchedule>()(
  'InvalidRoutineSchedule',
  { message: Schema.String },
  { title: 'Invalid Routine schedule' },
) {}

export interface RoutineSchedulerService {
  readonly validate: (cron: string, timezone: string) => Effect.Effect<void, InvalidRoutineSchedule>
  readonly schedule: (
    routine: Routine,
  ) => Effect.Effect<void, InvalidRoutineSchedule | DatabaseInfrastructureError>
  readonly run: (
    id: RoutineId,
  ) => Effect.Effect<Option.Option<Occurrence>, DatabaseInfrastructureError | RuntimeUnavailable>
  readonly runDue: () => Effect.Effect<
    void,
    InvalidRoutineSchedule | DatabaseInfrastructureError | RuntimeUnavailable
  >
}

export class RoutineScheduler extends Context.Service<RoutineScheduler, RoutineSchedulerService>()(
  'vivid/RoutineScheduler',
) {}

export const routineSchedulerServiceLayer = Layer.effect(
  RoutineScheduler,
  Effect.gen(function* () {
    const routines = yield* RoutineStore
    const threads = yield* ThreadStore
    const runtime = yield* Runtime

    const probe = Effect.fn('RoutineScheduler.probe')(function* (cron: string, timezone: string) {
      return yield* Effect.try({
        try: () => {
          new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
          return new Cron(cron, { paused: true, timezone })
        },
        catch: () =>
          new InvalidRoutineSchedule({ message: 'Routine schedule or timezone is invalid' }),
      })
    })

    const validate = Effect.fn('RoutineScheduler.validate')(function* (
      cron: string,
      timezone: string,
    ) {
      const value = yield* probe(cron, timezone)
      value.stop()
    })

    const schedule = Effect.fn('RoutineScheduler.schedule')(function* (routine: Routine) {
      if (!routine.enabled) {
        yield* routines.setSchedule(routine.id, null, routine.lastMissedAt)
        return
      }
      const now = yield* Clock.currentTimeMillis
      const value = yield* probe(routine.cron, routine.timezone)
      const next = value.nextRun(new Date(now))
      value.stop()
      yield* routines.setSchedule(
        routine.id,
        next === null ? null : next.getTime(),
        routine.lastMissedAt,
      )
    })

    const submit = Effect.fn('RoutineScheduler.submit')(function* (routine: Routine) {
      const occurrence = yield* routines.startOccurrence(routine.id)
      yield* threads.put(
        ThreadSchema.make({
          id: occurrence.conversationId,
          title: routine.name,
          preview: `Routine: ${routine.prompt}`.slice(0, 500),
          updatedAt: occurrence.startedAt,
          archived: false,
        }),
      )
      const body =
        routine.libraryFolderId === null
          ? routine.prompt
          : `${routine.prompt}\n\nSearch Library folder "${routine.libraryFolderId}" and cite every source used.`
      // The Library folder is present only for a Routine scoped to one; the two shapes are built
      // whole so no key is added to an object after the fact.
      const base = {
        routineId: routine.id,
        routineName: routine.name,
        scheduledAt: new Date(occurrence.startedAt).toISOString(),
      }
      const attributes =
        routine.libraryFolderId === null
          ? base
          : Object.assign({}, base, { libraryFolderId: routine.libraryFolderId })
      const receipt = yield* runtime.start({
        threadId: occurrence.conversationId,
        idempotencyKey: occurrence.id,
        type: 'schedule',
        body,
        attributes,
      })
      yield* routines.attachSubmission(occurrence.id, receipt.submissionId)
      return Occurrence.make({
        id: occurrence.id,
        routineId: occurrence.routineId,
        conversationId: occurrence.conversationId,
        submissionId: receipt.submissionId,
        status: occurrence.status,
        startedAt: occurrence.startedAt,
        finishedAt: occurrence.finishedAt,
        output: occurrence.output,
        error: occurrence.error,
      })
    })

    const run = Effect.fn('RoutineScheduler.run')(function* (id: RoutineId) {
      const routine = yield* routines.get(id)
      return routine === undefined ? Option.none() : Option.some(yield* submit(routine))
    })

    /** Advances one claimed Routine and submits its occurrence before the next claim. */
    const runDueRoutine = Effect.fn('RoutineScheduler.runDueRoutine')(function* (routine: Routine) {
      yield* schedule(routine)
      yield* submit(routine)
    })

    const runDue = Effect.fn('RoutineScheduler.runDue')(function* () {
      const due = yield* routines.claimDue()
      yield* Effect.forEach(due, runDueRoutine, { discard: true, concurrency: 1 })
    })

    return RoutineScheduler.of({ validate, schedule, run, runDue })
  }),
)

/** Owns the scoped Routine polling fiber; no Cron callback or detached timer survives shutdown. */
export const routineSchedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* RoutineScheduler
    const pass = scheduler.runDue().pipe(
      Effect.tapError((error) => Effect.logError('Routine scheduler pass failed', error)),
      Effect.ignore,
    )
    yield* pass.pipe(Effect.repeat(Schedule.spaced(`${ROUTINE_TICK_MS} millis`)), Effect.forkScoped)
  }),
)
