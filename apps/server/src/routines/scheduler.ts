import * as Context from 'effect/Context'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import {
  type Conflict,
  Occurrence,
  RunState,
  ThreadId,
  NotFound,
  type RoutineId,
  type RuntimeUnavailable,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Changes, Topic } from '../live/changes.ts'
import { observeFailures } from '../observability/failure.ts'
import {
  Conversation,
  DeliverySpeaker,
  DeliveryMessage,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { standingRoutine } from '@vivid/skills'
import {
  identifyAttempt,
  OccurrenceClaim,
  OccurrenceOpening,
  OccurrenceFailure,
  RoutineInvocation,
  RoutineThreadUnavailable,
  THREAD_OPENING_FAILURE,
  type RoutineAttempt,
} from './attempts.ts'
import type { RoutineRecord } from './records.ts'
import { IntegrationNotice, IntegrationStopReason } from './integration.ts'
import { RoutineStore, ScheduledFailure, type RoutineMissing } from './store.ts'
import type { InvalidRoutineSchedule } from './timing.ts'
import { untracedTimer } from '../observability/timer.ts'

const isNotFound = Schema.is(NotFound)

export type RoutineDeliveryError =
  | Conflict
  | DatabaseInfrastructureError
  | RoutineMissing
  | RoutineThreadUnavailable
  | NotFound
  | RuntimeUnavailable

export interface RoutineSchedulerService {
  readonly run: (actor: Actor, id: RoutineId) => Effect.Effect<Occurrence, RoutineDeliveryError>
  readonly webhook: (
    record: RoutineRecord,
    payload: string,
    invocation: RoutineInvocation,
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
export const bodyOf = (record: RoutineRecord, payload: Option.Option<string>) => {
  const routine = record.routine
  const prompt =
    routine.libraryFolderId === null
      ? routine.prompt
      : `${routine.prompt}\n\nSearch this Routine's Library folder and cite every source used.`
  return Option.match(payload, {
    onNone: () => prompt,
    onSome: (text) => `${prompt}\n\nPayload:\n${text}`,
  })
}

/** Only the Routine's human-readable name belongs in Flue's model-visible attributes. */
export function deliveryAttributes(record: RoutineRecord) {
  return DeliveryMessage.cases.Signal.fields.attributes.make({ name: record.routine.name })
}

interface SubmissionServices {
  readonly routines: RoutineStore['Service']
  readonly threads: ThreadStore['Service']
  readonly conversation: Conversation['Service']
  readonly changes: Changes['Service']
  readonly notifier: Notifier['Service']
}

/** A recorded opening failure stays a failure on retry; an admitted receipt retains its Run. */
const replay = Effect.fn('RoutineScheduler.replay')(function* (occurrence: Occurrence) {
  if (occurrence.submissionId === null && occurrence.error === THREAD_OPENING_FAILURE) {
    return yield* Effect.fail(
      new RoutineThreadUnavailable({
        routineId: occurrence.routineId,
        threadId: occurrence.threadId,
      }),
    )
  }
  return occurrence.submissionId === null ? Option.none<Occurrence>() : Option.some(occurrence)
})

/** A failed opening records its own immutable outcome and alerts only the receipt's owning Person. */
const openingFailed = Effect.fn('RoutineScheduler.openingFailed')(function* (
  services: SubmissionServices,
  record: RoutineRecord,
  attempt: RoutineAttempt,
) {
  const claim = yield* services.routines.claimOccurrence(
    record,
    attempt,
    OccurrenceOpening.cases.Failed.make({ reason: THREAD_OPENING_FAILURE }),
  )
  const recorded = yield* services.routines.failOccurrence(
    attempt.id,
    OccurrenceFailure.cases.Opening.make({}),
  )
  if (OccurrenceClaim.guards.Created(claim) || recorded) {
    yield* publish(services.changes)(record)
    // The conflicting Thread may belong to someone else; this notice must never link to it.
    yield* services.notifier.notify({
      personId: record.personId,
      companyId: record.companyId,
      kind: 'needs-you',
      title: record.routine.name,
      body: THREAD_OPENING_FAILURE,
      threadId: null,
    })
  }
  return yield* Effect.fail(
    new RoutineThreadUnavailable({
      routineId: record.routine.id,
      threadId: claim.occurrence.threadId,
    }),
  )
})

/** Ensuring a Thread is a product operation: database failures become a recorded opening failure. */
const openThread = Effect.fn('RoutineScheduler.openThread')(function* (
  services: SubmissionServices,
  record: RoutineRecord,
  attempt: RoutineAttempt,
) {
  return yield* services.threads
    .ensure({
      id: ThreadId.make(`routine-${record.routine.id}`),
      title: record.routine.name,
      // Inherit the durable Routine name without attributing its authorship to a Person or the title model.
      titleSource: 'Assigned',
      personId: record.personId,
      companyId: record.companyId,
    })
    .pipe(
      Effect.catchTag('DatabaseConstraintViolation', () =>
        openingFailed(services, record, attempt),
      ),
    )
})

/** A unique receipt persists the attempt; Conversation deduplicates admissions by the original key. */
const makeSubmit = (services: SubmissionServices) =>
  Effect.fn('RoutineScheduler.submit')(function* (
    record: RoutineRecord,
    payload: Option.Option<string>,
    attempt: RoutineAttempt,
  ) {
    const routine = record.routine
    const existing = yield* services.routines.findOccurrence(record, attempt.id)
    if (Option.isSome(existing)) {
      const outcome = yield* replay(existing.value)
      if (Option.isSome(outcome)) return outcome.value
    }
    const thread = yield* openThread(services, record, attempt)
    const claim = yield* services.routines.claimOccurrence(
      record,
      attempt,
      OccurrenceOpening.cases.Ready.make({}),
    )
    if (OccurrenceClaim.guards.Existing(claim)) {
      const outcome = yield* replay(claim.occurrence)
      if (Option.isSome(outcome)) return outcome.value
    }
    // A receipt without a Run may have lost admission or attachment. Conversation owns idempotent
    // delivery, so repeating the original key safely recovers it, even across server instances.
    const occurrence = claim.occurrence
    const threadId = thread.id
    yield* publish(services.changes)(record)
    const run = yield* services.conversation
      .deliver({
        speaker: DeliverySpeaker.cases.Acting.make({}),
        threadId,
        personId: record.personId,
        libraryFolder: routine.libraryFolderId,
        message: DeliveryMessage.cases.Signal.make({
          type: 'schedule',
          body: bodyOf(record, payload),
          attributes: deliveryAttributes(record),
        }),
        origin:
          routine.prompt === standingRoutine.prompt
            ? StoredRunOrigin.cases.Standing.make({ routineName: routine.name })
            : StoredRunOrigin.cases.Routine.make({ routineName: routine.name }),
        idempotencyKey: attempt.deliveryKey,
      })
      .pipe(
        Effect.tapError((error) =>
          services.routines.failOccurrence(
            occurrence.id,
            isNotFound(error)
              ? OccurrenceFailure.cases.Opening.make({})
              : OccurrenceFailure.cases.Delivery.make({
                  reason: `Delivery was not admitted (${error._tag})`,
                }),
          ),
        ),
      )
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
      error: null,
    })
  })

/** A claim may commit just before Membership is revoked; that receipt still needs a terminal reason. */
const submitScheduled = Effect.fn('RoutineScheduler.submitScheduled')(function* (
  routines: RoutineStore['Service'],
  submit: ReturnType<typeof makeSubmit>,
  record: RoutineRecord,
  attempt: RoutineAttempt,
) {
  return yield* submit(record, Option.none(), attempt).pipe(
    Effect.tapErrorTag('RoutineMissing', () =>
      routines.failOccurrence(attempt.id, ScheduledFailure.cases.Membership.make({})),
    ),
  )
})

/** A durable notice key owns one Thread admission, independent of other Routine deliveries. */
const sendIntegrationNotice = (services: SubmissionServices) =>
  Effect.fn('RoutineScheduler.integrationNotice')(function* ({
    record,
    notice,
  }: Effect.Success<ReturnType<RoutineStore['Service']['integrationNotices']>>[number]) {
    const thread = yield* services.threads.ensure({
      id: ThreadId.make(`routine-${record.routine.id}`),
      title: record.routine.name,
      // Inherit the durable Routine name without attributing its authorship to a Person or the title model.
      titleSource: 'Assigned',
      personId: record.personId,
      companyId: record.companyId,
    })
    yield* services.conversation.deliver({
      speaker: DeliverySpeaker.cases.Vivid.make({}),
      threadId: thread.id,
      personId: record.personId,
      libraryFolder: record.routine.libraryFolderId,
      message: DeliveryMessage.cases.Signal.make({
        type: 'schedule',
        body: IntegrationNotice.guards.GapPending(notice)
          ? `${record.routine.name}: ${notice.reason}. Tell the Person once; do not perform the Routine's work.`
          : `${record.routine.name} is paused: ${notice.reason}. Tell the Person once; do not perform the Routine's work.`,
        attributes: deliveryAttributes(record),
      }),
      origin: StoredRunOrigin.cases.Routine.make({ routineName: record.routine.name }),
      idempotencyKey: `integration-pause-${notice.key}`,
    })
    yield* services.routines.markIntegrationNotified(record.routine.id, notice)
    yield* publish(services.changes)(record)
  })

/** Attempt every notice before propagating a failure. A busy or vanished Thread retains only its
 * own pending key; it cannot starve the other Routines' notices on this or subsequent passes. */
const sendIntegrationNotices = (services: SubmissionServices) =>
  Effect.fn('RoutineScheduler.integrationNotices')(function* () {
    const notices = yield* services.routines.integrationNotices()
    const send = sendIntegrationNotice(services)
    const outcomes = yield* Effect.forEach(notices, (notice) => Effect.exit(send(notice)))
    for (const outcome of outcomes) yield* outcome
  })

/** Authorization loss pauses one Routine; transient reads defer it and cursor gaps re-baseline from now. */
const observeIntegrations = (services: SubmissionServices) =>
  Effect.fn('RoutineScheduler.observeIntegrations')(function* () {
    const integrations = services.routines
    const claimed = yield* integrations.claimWatches()
    for (const record of claimed) {
      const observed = integrations.readIntegration(record).pipe(
        Effect.flatMap((batch) => integrations.recordEvents(record, batch)),
        Effect.catchTags({
          IntegrationRevoked: () =>
            integrations.pauseIntegration(record, IntegrationStopReason.cases.Revoked.make({})),
          IntegrationReadFailed: () => integrations.backoffIntegration(record),
          IntegrationCursorLost: ({ cursor, reason }) =>
            integrations.rebaselineIntegration(
              record,
              cursor,
              reason === 'Ordering'
                ? 'Its Integration returned new items below the cursor; watching again from now without replaying older items'
                : 'Its Integration observation window was exceeded; watching again from now without replaying older items',
            ),
        }),
      )
      yield* observed
      yield* publish(services.changes)(record)
    }
  })

/** Persist before admission and stop a Routine's burst at the first refusal, retaining ordered replay. */
const makeIntegrationPass = (services: SubmissionServices, submit: ReturnType<typeof makeSubmit>) =>
  Effect.fn('RoutineScheduler.integrationPass')(function* () {
    yield* observeIntegrations(services)()
    const pending = yield* services.routines.pendingEvents()
    const groups = Arr.groupBy(pending, (receipt) => receipt.record.routine.id)
    const outcomes = yield* Effect.forEach(Object.values(groups), (receipts) =>
      Effect.exit(
        Effect.forEach(
          receipts,
          ({ record, attempt, event }) =>
            submit(record, Option.some(JSON.stringify(event.content)), attempt),
          { discard: true },
        ),
      ),
    )
    yield* sendIntegrationNotices(services)()
    for (const outcome of outcomes) yield* outcome
  })

/** Captures delivery authorities once; manual calls still supply their current Actor per request. */
export const routineSchedulerServiceLayer = Layer.effect(
  RoutineScheduler,
  Effect.gen(function* () {
    const routines = yield* RoutineStore
    const threads = yield* ThreadStore
    const conversation = yield* Conversation
    const changes = yield* Changes
    const notifier = yield* Notifier
    const services = { routines, threads, conversation, changes, notifier }
    const submit = makeSubmit(services)
    const integrationPass = makeIntegrationPass(services, submit)

    /** Loading through the owner predicate makes another Person's id indistinguishable from absence. */
    const run = Effect.fn('RoutineScheduler.run')(function* (actor: Actor, id: RoutineId) {
      return yield* submit(
        yield* routines.get(actor, id),
        Option.none(),
        identifyAttempt(id, RoutineInvocation.cases.Fresh.make({})),
      )
    })

    /** A webhook's authority is its key alone and never a browser session. */
    const webhook = Effect.fn('RoutineScheduler.webhook')(function* (
      record: RoutineRecord,
      payload: string,
      invocation: RoutineInvocation,
    ) {
      return yield* submit(
        record,
        Option.some(payload),
        identifyAttempt(record.routine.id, invocation),
      )
    })

    /** Every claimed tick already has a receipt; failed admissions remain replayable on later passes. */
    const runDue = Effect.fn('RoutineScheduler.runDue')(function* () {
      const due = yield* routines.claimDue()
      yield* Effect.forEach(due, ({ record }) => publish(changes)(record), { discard: true })
      const outcomes = yield* Effect.forEach(due, ({ record, attempt }) =>
        Effect.exit(submitScheduled(routines, submit, record, attempt)),
      )
      const integrationOutcome = yield* Effect.exit(integrationPass())
      for (const outcome of outcomes) yield* outcome
      yield* integrationOutcome
    })
    return RoutineScheduler.of({ run, webhook, runDue })
  }),
)

/** The scoped worker owns no detached timers, and retries only the next due pass after failure. */
export const routineSchedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* RoutineScheduler
    const pass = scheduler.runDue().pipe(
      // Recorded before `ignore` discards the failure; the retry on the next pass is unchanged.
      observeFailures('schedule'),
      Effect.tapError((error) => Effect.logError('Routine scheduler pass failed', error)),
      Effect.ignore,
    )
    yield* pass.pipe(untracedTimer, Effect.repeat(Schedule.spaced('20 seconds')), Effect.forkScoped)
  }),
)
