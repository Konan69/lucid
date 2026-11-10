import {
  ActionReceipt,
  ActionTarget,
  ApprovalBinding,
  IntegrationAnswerOutcome,
  IntegrationPause,
  ProposedAction,
  ToolOutcome,
  InvalidRequest,
  integrationExpiredMessage,
  integrationWaitingMessage,
  type IntegrationResponse,
} from '@vivid/contracts'
import { Clock, Effect, Layer, Option, Result } from 'effect'
import { ApprovalStore } from '../approvals/store.ts'
import { InputStore } from '../inputs/store.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { resultDigest, settle, originOf } from '../actions/journal.ts'
import type { Actor } from '../auth/access.ts'
import { ConnectionStore } from './store.ts'
import { ExecutorCallOutcome } from './executor.ts'
import { ExecutorMembers, operationsOf } from './members.ts'
import { Executor } from './executor.ts'
import { IntegrationAnswers } from './answers.ts'
import { notRead } from './coverage.ts'

/** Raise the app's question through the same stores that feed Thread, Needs you and notifications. */
const pause = Effect.fn('IntegrationAsks.pause')(function* (actor: Actor, action: ProposedAction) {
  if (action.continuation === null || !ActionTarget.guards.Connection(action.target))
    return yield* new InvalidRequest({ message: 'Integration question has no saved call.' })
  const addressed: Actor = {
    ...actor,
    threadId: Option.some((yield* originOf(action.continuation.operation)).threadId),
  }
  const request = action.continuation.pause
  if (IntegrationPause.guards.Approval(request)) {
    const row = yield* (yield* ConnectionStore).get(addressed, action.target.connectionId)
    const approval = yield* (yield* ApprovalStore).raise(
      addressed,
      action,
      ApprovalBinding.make({
        connectionGeneration: row.authorizationGeneration,
        preconditions: [],
      }),
    )
    return yield* notRead(
      ToolOutcome.cases.ApprovalRequired.make({ approvalId: approval.id, summary: action.summary }),
    )
  }
  const input = yield* (yield* InputStore).askIntegration(addressed, action)
  return yield* notRead(
    ToolOutcome.cases.InputRequired.make({
      requestId: input.id,
      questions: [request.form.message],
    }),
  )
})

/** The saved operation is settled only by a provider answer or explicit uncertainty, never by waiting. */
const record = Effect.fn('IntegrationAsks.record')(function* (
  action: ProposedAction,
  outcome: IntegrationAnswerOutcome,
) {
  if (action.continuation === null) return
  const operationId = action.continuation.operation
  const now = yield* Clock.currentTimeMillis
  yield* IntegrationAnswerOutcome.match(outcome, {
    Accepted: () => settle(ActionReceipt.cases.Accepted.make({ operationId, acceptedAt: now })),
    Completed: ({ value }) =>
      settle(
        ActionReceipt.cases.Completed.make({
          operationId,
          completedAt: now,
          resultDigest: resultDigest(value),
        }),
      ),
    Waiting: () => Effect.void,
    Expired: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    Uncertain: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    // App setup may have acted even before approval, and an input decline runs app code.
    Declined: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    Cancelled: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
  })
  const origin = yield* originOf(operationId)
  if (origin.approvalId !== null)
    yield* (yield* ApprovalStore).completeIntegration(origin.approvalId, outcome)
})

/** A decision names the original request and the Connection's own caller. Nothing here reissues a call. */
const answer = Effect.fn('IntegrationAsks.answer')(function* (
  actor: Actor,
  action: ProposedAction,
  response: IntegrationResponse,
) {
  if (action.continuation === null || !ActionTarget.guards.Connection(action.target))
    return yield* new InvalidRequest({ message: 'Integration question has no saved call.' })
  const row = yield* (yield* ConnectionStore).get(actor, action.target.connectionId)
  const saved = action.continuation
  const resumed = yield* operationsOf(row).pipe(
    Effect.flatMap((operation) => operation.resume({ pause: saved.pause, response })),
    Effect.result,
  )
  const result = Result.isSuccess(resumed)
    ? resumed.success
    : ExecutorCallOutcome.cases.OutcomeUnknown.make({})
  const outcome = yield* ExecutorCallOutcome.match<
    Effect.Effect<
      IntegrationAnswerOutcome,
      import('@vivid/contracts').NotFound | InvalidRequest | DatabaseInfrastructureError,
      ApprovalStore | ConnectionStore | InputStore | Database
    >
  >(result, {
    Completed: ({ value }) =>
      Effect.succeed(
        response.action === 'accept'
          ? IntegrationAnswerOutcome.cases.Completed.make({ value })
          : declined(response),
      ),
    Accepted: ({ value }) =>
      Effect.succeed(IntegrationAnswerOutcome.cases.Accepted.make({ value })),
    Paused: Effect.fnUntraced(function* ({ pause: next }) {
      yield* pause(
        actor,
        ProposedAction.make({
          summary: action.summary,
          rationale: action.rationale,
          effect: action.effect,
          target: action.target,
          continuation: {
            pause: next,
            operation: saved.operation,
          },
        }),
      )
      return IntegrationAnswerOutcome.cases.Waiting.make({})
    }),
    Expired: () => Effect.succeed(IntegrationAnswerOutcome.cases.Expired.make({})),
    UncertainPause: () => Effect.succeed(IntegrationAnswerOutcome.cases.Uncertain.make({})),
    OutcomeUnknown: () =>
      Effect.succeed(
        response.action === 'accept'
          ? IntegrationAnswerOutcome.cases.Uncertain.make({})
          : declined(response),
      ),
    NotReady: () => Effect.succeed(IntegrationAnswerOutcome.cases.Uncertain.make({})),
    Rejected: () =>
      Effect.succeed(
        response.action === 'accept'
          ? IntegrationAnswerOutcome.cases.Uncertain.make({})
          : declined(response),
      ),
  })
  yield* record(action, outcome)
  return outcome
})

/** Decline and cancel remain distinct decisions even when Executor reports the tool call as failed. */
const declined = (response: IntegrationResponse) =>
  response.action === 'cancel'
    ? IntegrationAnswerOutcome.cases.Cancelled.make({})
    : IntegrationAnswerOutcome.cases.Declined.make({})

/** Public words contain no credentials or provider diagnostics. */
export const integrationAnswerText = (outcome: IntegrationAnswerOutcome) =>
  IntegrationAnswerOutcome.match(outcome, {
    Accepted: ({ value }) =>
      `The Integration accepted the saved call; its result is not confirmed yet. ${JSON.stringify(value)}`,
    Completed: ({ value }) => `The Integration completed the saved call. ${JSON.stringify(value)}`,
    Declined: () => 'The Person declined the Integration request. Do not repeat it.',
    Cancelled: () => 'The Person cancelled the Integration request. Do not repeat it.',
    Expired: () => integrationExpiredMessage,
    Waiting: () => integrationWaitingMessage,
    Uncertain: () =>
      'The Integration may or may not have acted. Check what happened before asking for it again.',
  }).slice(0, 4000)

/** Construct after the two question stores. Only answer methods need this bridge, so store acquisition is acyclic. */
export const integrationAnswersLayer = Layer.effect(
  IntegrationAnswers,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Database | ConnectionStore | Executor | ExecutorMembers | ApprovalStore | InputStore
    >()
    return IntegrationAnswers.of({
      settle: (action, outcome) => record(action, outcome).pipe(Effect.provide(context)),
      pause: (actor, action) => pause(actor, action).pipe(Effect.provide(context)),
      answer: (actor, action, response) =>
        answer(actor, action, response).pipe(Effect.provide(context)),
    })
  }),
)
