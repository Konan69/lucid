import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import {
  Occurrence,
  RunState,
  ThreadId,
  type NotFound,
  type RoutineId,
  type RuntimeUnavailable,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Conversation, DeliveryMessage, StoredRunOrigin } from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import type { RoutineRecord } from './records.ts'
import { RoutineStore, type RoutineMissing } from './store.ts'
import type { InvalidRoutineSchedule } from './timing.ts'

export type RoutineDeliveryError =
  | DatabaseInfrastructureError
  | RoutineMissing
  | NotFound
  | RuntimeUnavailable

export interface RoutineSchedulerService {
  readonly run: (actor: Actor, id: RoutineId) => Effect.Effect<Occurrence, RoutineDeliveryError>
  readonly webhook: (
    record: RoutineRecord,
    payload: string,
  ) => Effect.Effect<Occurrence, RoutineDeliveryError>
  readonly runDue: () => Effect.Effect<void, RoutineDeliveryError | InvalidRoutineSchedule>
}

export class RoutineScheduler extends Context.Service<RoutineScheduler, RoutineSchedulerService>()(
  'vivid/RoutineScheduler',
) {}

/** Background writes name their durable owner, without manufacturing a session or Actor. */
const publish = (changes: Changes['Service']) =>
  Effect.fn('RoutineScheduler.publish')(function* (record: RoutineRecord) {
    const topics = [Topic.person(record.personId)]
    if (record.companyId !== null) topics.push(Topic.company(record.companyId))
    yield* changes.publish(topics)
  })

/** The prompt keeps its Library scope; webhook text is appended as the outside payload. */
const bodyOf = (record: RoutineRecord, payload: Option.Option<string>) => {
  const routine = record.routine
  const prompt =
    routine.libraryFolderId === null
      ? routine.prompt
      : `${routine.prompt}\n\nSearch Library folder "${routine.libraryFolderId}" and cite every source used.`
  return Option.match(payload, {
    onNone: () => prompt,
    onSome: (text) => `${prompt}\n\nPayload:\n${text}`,
  })
}

/** All three triggers establish the private Thread, persist the Occurrence, then deliver once. */
const makeSubmit = (services: {
  readonly routines: RoutineStore['Service']
  readonly threads: ThreadStore['Service']
  readonly conversation: Conversation['Service']
  readonly changes: Changes['Service']
}) =>
  Effect.fn('RoutineScheduler.submit')(function* (
    record: RoutineRecord,
    payload: Option.Option<string>,
  ) {
    const routine = record.routine
    const threadId = ThreadId.make(`routine-${routine.id}`)
    yield* services.threads.ensure({
      id: threadId,
      title: routine.name,
      personId: record.personId,
      companyId: record.companyId,
    })
    const occurrence = yield* services.routines.startOccurrence(record, threadId)
    yield* publish(services.changes)(record)
    const run = yield* services.conversation.deliver({
      threadId,
      personId: record.personId,
      message: DeliveryMessage.cases.Signal.make({
        type: 'schedule',
        body: bodyOf(record, payload),
        attributes: { routine: routine.id, name: routine.name },
      }),
      origin: StoredRunOrigin.cases.Routine.make({ routineName: routine.name }),
      idempotencyKey: occurrence.id,
    })
    yield* services.routines.attachSubmission(occurrence.id, run.id)
    yield* publish(services.changes)(record)
    const outcome = RunState.match(run.state, {
      Working: (): Pick<Occurrence, 'status' | 'finishedAt'> => ({
        status: 'running' as const,
        finishedAt: null,
      }),
      Completed: ({ finishedAt }): Pick<Occurrence, 'status' | 'finishedAt'> => ({
        status: 'succeeded' as const,
        finishedAt,
      }),
      Failed: ({ finishedAt }) => ({ status: 'failed' as const, finishedAt }),
      Stopped: ({ finishedAt }) => ({ status: 'failed' as const, finishedAt }),
      Unknown: ({ finishedAt }) => ({ status: 'failed' as const, finishedAt }),
    })
    return Occurrence.make({
      id: occurrence.id,
      routineId: occurrence.routineId,
      threadId: occurrence.threadId,
      submissionId: run.id,
      status: outcome.status,
      startedAt: occurrence.startedAt,
      finishedAt: outcome.finishedAt,
      output: occurrence.output,
      error: occurrence.error,
    })
  })

/** Captures delivery authorities once; manual calls still supply their current Actor per request. */
export const routineSchedulerServiceLayer = Layer.effect(
  RoutineScheduler,
  Effect.gen(function* () {
    const routines = yield* RoutineStore
    const threads = yield* ThreadStore
    const conversation = yield* Conversation
    const changes = yield* Changes
    const submit = makeSubmit({ routines, threads, conversation, changes })

    /** Loading through the owner predicate makes another Person's id indistinguishable from absence. */
    const run = Effect.fn('RoutineScheduler.run')(function* (actor: Actor, id: RoutineId) {
      return yield* submit(yield* routines.get(actor, id), Option.none())
    })

    /** A webhook's authority is its key alone and never a browser session. */
    const webhook = Effect.fn('RoutineScheduler.webhook')(function* (
      record: RoutineRecord,
      payload: string,
    ) {
      return yield* submit(record, Option.some(payload))
    })

    /** Claims are advanced first; a failed delivery is reported without starving other claimed work. */
    const runDue = Effect.fn('RoutineScheduler.runDue')(function* () {
      const due = yield* routines.claimDue()
      yield* Effect.forEach(due, publish(changes), { discard: true })
      const outcomes = yield* Effect.forEach(due, (record) =>
        Effect.exit(submit(record, Option.none())),
      )
      for (const outcome of outcomes) yield* outcome
    })
    return RoutineScheduler.of({ run, webhook, runDue })
  }),
)

/** The scoped worker owns no detached timers, and retries only the next due pass after failure. */
export const routineSchedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* RoutineScheduler
    const pass = scheduler.runDue().pipe(
      Effect.tapError((error) => Effect.logError('Routine scheduler pass failed', error)),
      Effect.ignore,
    )
    yield* pass.pipe(Effect.repeat(Schedule.spaced('20 seconds')), Effect.forkScoped)
  }),
)
