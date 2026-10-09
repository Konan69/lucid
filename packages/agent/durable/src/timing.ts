import type { Context } from '@earendil-works/chord'
import type { Harness, TaskId } from '@earendil-works/pi-durable'
import { Effect, Option, Schema } from 'effect'
import { PiFailed } from './errors.ts'

/** Pi 1.1.0 TaskRecord lifecycle times are wall-clock milliseconds, independent
 * of monotonic response/tool durations. Legacy records legitimately have neither. */
export const TaskTiming = Schema.Struct({
  startedAt: Schema.Option(Schema.Finite),
  endedAt: Schema.Option(Schema.Finite),
})
export type TaskTiming = typeof TaskTiming.Type
export const absentTiming = TaskTiming.make({ startedAt: Option.none(), endedAt: Option.none() })

/** Read the exact durable task, never substitute provider timestamps or now().
 * Host-written assistant entries have no task; an attributed missing task is a
 * broken Pi relation and remains an adapter failure rather than invented absence. */
export const taskTiming: (
  harness: Harness,
  taskId: Option.Option<TaskId>,
  context: Context,
) => Effect.Effect<TaskTiming, PiFailed> = Effect.fn('Durable.taskTiming')(function* (
  harness: Harness,
  taskId: Option.Option<TaskId>,
  context: Context,
) {
  if (Option.isNone(taskId)) return absentTiming
  const task = yield* Effect.tryPromise({
    try: () => harness.getTask(taskId.value, context),
    catch: (cause) => new PiFailed({ operation: 'task', cause }),
  })
  if (task === undefined)
    return yield* new PiFailed({
      operation: 'task',
      cause: new Error('Attributed task is missing'),
    })
  return TaskTiming.make({
    startedAt: Option.fromNullishOr(task.startedAt),
    endedAt: Option.fromNullishOr(task.endedAt),
  })
})
