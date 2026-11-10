import type { ConnectionRecord } from './records.ts'
import type { NotFound } from '@vivid/contracts'
import { Gate, GateDecision, type GateBasis } from '../approvals/gate.ts'
import { exposureOf } from './tools.ts'
import { observeFailures } from '../observability/failure.ts'
import { Message } from '../observability/messages.ts'
import {
  ActionReceipt,
  ActionTarget,
  AuditEvent,
  ApprovalBinding,
  IntegrationPause,
  IntegrationAnswerOutcome,
  ProposedAction,
  ToolOutcome,
  InvalidRequest,
  integrationExpiredMessage,
  integrationWaitingMessage,
  type IntegrationResponse,
  type IntegrationResult,
} from '@vivid/contracts'
import { Clock, Effect, Layer, Option, Result } from 'effect'
import { ApprovalStore } from '../approvals/store.ts'
import { InputStore } from '../inputs/store.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { resultDigest, settle, originOf, release } from '../actions/journal.ts'
import type { Actor } from '../auth/access.ts'
import { ConnectionStore } from './store.ts'
import { ExecutorCallOutcome, ExecutorRejected } from './executor.ts'
import { ExecutorMembers, operationsOf } from './members.ts'
import { Executor } from './executor.ts'
import { IntegrationAnswers } from './answers.ts'
import { notRead } from './coverage.ts'
import { Audit } from '../audit/record.ts'
import { auditAction } from '../approvals/action.ts'

/** Raise the app's question through the same stores that feed Thread, Needs you and notifications. */
const pause = Effect.fn('IntegrationAsks.pause')(function* (actor: Actor, action: ProposedAction) {
  if (action.continuation === null || !ActionTarget.guards.Connection(action.target))
    return yield* new InvalidRequest({ message: 'Integration question has no saved call.' })
  const addressed: Actor = {
    ...actor,
    threadId: Option.some((yield* originOf(action.continuation.operation)).threadId),
  }
  yield* Effect.annotateCurrentSpan({
    'vivid.connection.id': action.target.connectionId,
    'vivid.operation.id': action.continuation.operation,
    'vivid.executor.request': action.continuation.pause.requestId,
    'vivid.integration.pause': action.continuation.pause._tag,
  })
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
    yield* Effect.annotateCurrentSpan('vivid.approval.id', approval.id)
    yield* Effect.logInfo(Message.integrationPause).pipe(
      Effect.annotateLogs({
        'vivid.connection.id': action.target.connectionId,
        'vivid.operation.id': action.continuation.operation,
        'vivid.approval.id': approval.id,
        'vivid.integration.pause': request._tag,
      }),
    )
    return yield* notRead(
      ToolOutcome.cases.ApprovalRequired.make({ approvalId: approval.id, summary: action.summary }),
    )
  }
  const input = yield* (yield* InputStore).askIntegration(addressed, action)
  yield* Effect.annotateCurrentSpan('vivid.input.id', input.id)
  yield* Effect.logInfo(Message.integrationPause).pipe(
    Effect.annotateLogs({
      'vivid.connection.id': action.target.connectionId,
      'vivid.operation.id': action.continuation.operation,
      'vivid.input.id': input.id,
      'vivid.integration.pause': request._tag,
    }),
  )
  return yield* notRead(
    ToolOutcome.cases.InputRequired.make({
      requestId: input.id,
      questions: [request.form.message],
    }),
  )
})

/** Once authorized, successive pauses belong to the same saved invocation. */
const resumeApproved = Effect.fn('IntegrationAsks.resumeApproved')(function* (
  actor: Actor,
  row: ConnectionRecord,
  input: {
    readonly pause: IntegrationPause
    readonly action: ProposedAction
    readonly basis: Extract<GateBasis, 'Reviewed' | 'PersonApproved' | 'PersonPress'>
  },
) {
  let current = input.pause
  while (IntegrationPause.guards.Approval(current)) {
    const attributes = {
      'vivid.executor.request_id': current.requestId,
      'vivid.gate.basis': input.basis,
    }
    yield* Effect.annotateCurrentSpan(attributes)
    yield* Effect.logInfo(Message.executorApproval).pipe(Effect.annotateLogs(attributes))
    const audited = yield* (yield* Audit)
      .record(
        actor,
        AuditEvent.cases.ActionAllowed.make({
          ...auditAction(input.action),
          effect: input.action.effect,
          integrationApproval: { requestId: current.requestId, basis: input.basis },
        }),
      )
      .pipe(Effect.result)
    if (Result.isFailure(audited)) {
      yield* Effect.logError(Message.approvalAuditFailed).pipe(Effect.annotateLogs(attributes))
      return Result.succeed(ExecutorCallOutcome.cases.OutcomeUnknown.make({}))
    }
    const resumed = yield* operationsOf(row).pipe(
      Effect.flatMap((operation) =>
        operation.resume({
          pause: current,
          response: { action: 'accept', content: {} },
          effect: input.action.effect,
        }),
      ),
      Effect.result,
    )
    if (Result.isFailure(resumed)) {
      yield* Effect.logWarning(Message.executorContinuationFailed).pipe(
        Effect.annotateLogs(attributes),
      )
      return Result.succeed(
        resumed.failure instanceof ExecutorRejected
          ? ExecutorCallOutcome.cases.Rejected.make({
              message: resumed.failure.message,
              approvalAnswered: true,
            })
          : ExecutorCallOutcome.cases.OutcomeUnknown.make({ approvalAnswered: true }),
      )
    }
    const result = resumed.success
    if (
      !ExecutorCallOutcome.guards.Paused(result) ||
      !IntegrationPause.guards.Approval(result.pause)
    )
      return Result.succeed({ ...result, approvalAnswered: true as const })
    current = result.pause
  }
  return Result.succeed(ExecutorCallOutcome.cases.Paused.make({ pause: current }))
})

/** Approval metadata is consequence evidence, not permission. Only a review or the Person
 * authorizes resumption; the fallback preserves the exact request for one Vivid Approval. */
const approve = Effect.fn('IntegrationAsks.approve')(function* (
  actor: Actor,
  input: {
    readonly action: ProposedAction
    readonly pause: IntegrationPause
    readonly basis: GateBasis
  },
): Effect.fn.Return<
  Result.Result<typeof ExecutorCallOutcome.Type, import('@vivid/contracts').IntegrationResult>,
  NotFound | InvalidRequest | DatabaseInfrastructureError,
  | Gate
  | ApprovalStore
  | InputStore
  | ConnectionStore
  | Database
  | Executor
  | ExecutorMembers
  | Audit
> {
  const action = input.action
  if (!ActionTarget.guards.Connection(action.target))
    return yield* new InvalidRequest({ message: 'Integration approval has no Connection.' })
  const addressed =
    action.continuation === null
      ? actor
      : {
          ...actor,
          threadId: Option.some((yield* originOf(action.continuation.operation)).threadId),
        }
  const row = yield* (yield* ConnectionStore).get(addressed, action.target.connectionId)
  const basis = input.basis
  if (basis === 'Unreviewed') return Result.fail(yield* pause(addressed, action))
  if (basis === 'Read' || basis === 'AllowRule' || basis === 'Contained') {
    const consequential = ProposedAction.make({
      summary: action.summary,
      rationale: action.rationale,
      effect: 'destructive',
      target: action.target,
      continuation: action.continuation,
    })
    const decision = yield* (yield* Gate).check(
      addressed,
      consequential,
      yield* exposureOf(addressed, row),
      ApprovalBinding.make({
        connectionGeneration: row.authorizationGeneration,
        preconditions: [],
      }),
    )
    return yield* GateDecision.match<
      Effect.Effect<
        Result.Result<typeof ExecutorCallOutcome.Type, IntegrationResult>,
        NotFound | InvalidRequest | DatabaseInfrastructureError,
        | Gate
        | ApprovalStore
        | InputStore
        | ConnectionStore
        | Database
        | Executor
        | ExecutorMembers
        | Audit
      >
    >(decision, {
      Allowed: ({ basis: reviewed }) =>
        reviewed === 'Reviewed'
          ? resumeApproved(addressed, row, { pause: input.pause, action, basis: reviewed })
          : pause(addressed, action).pipe(Effect.map(Result.fail)),
      ApprovalRequired: ({ approval }) =>
        notRead(
          ToolOutcome.cases.ApprovalRequired.make({
            approvalId: approval.id,
            summary: approval.action.summary,
          }),
        ).pipe(Effect.map(Result.fail)),
      Blocked: Effect.fn('IntegrationAsks.declineBlocked')(function* ({ rule }) {
        const declined = yield* operationsOf(row).pipe(
          Effect.flatMap((operation) =>
            operation.resume({
              pause: input.pause,
              response: { action: 'decline' },
              effect: action.effect,
            }),
          ),
          Effect.result,
        )
        if (Result.isFailure(declined) && !(declined.failure instanceof ExecutorRejected))
          return Result.succeed(ExecutorCallOutcome.cases.OutcomeUnknown.make({}))
        yield* record(action, IntegrationAnswerOutcome.cases.Declined.make({}))
        return Result.fail(yield* notRead(ToolOutcome.cases.Blocked.make({ rule })))
      }),
    })
  }
  return yield* resumeApproved(addressed, row, { pause: input.pause, action, basis })
})

/** The saved operation is settled only by a provider answer or explicit uncertainty, never by waiting. */
const record = Effect.fn('IntegrationAsks.record')(function* (
  action: ProposedAction,
  outcome: IntegrationAnswerOutcome,
) {
  if (action.continuation === null) return
  const operationId = action.continuation.operation
  yield* Effect.annotateCurrentSpan({
    'vivid.operation.id': operationId,
    'vivid.executor.request': action.continuation.pause.requestId,
    'vivid.integration.outcome': outcome._tag,
  })
  const now = yield* Clock.currentTimeMillis
  const origin = yield* originOf(operationId)
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
    Rejected: () => release(operationId),
    Waiting: () => Effect.void,
    Expired: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    Uncertain: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    // App setup may have acted even before approval, and an input decline runs app code.
    Declined: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
    Cancelled: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
  })
  if (IntegrationAnswerOutcome.guards.Expired(outcome))
    yield* Effect.logInfo(Message.integrationExpired).pipe(
      Effect.annotateLogs({
        'vivid.operation.id': operationId,
        'vivid.integration.outcome': outcome._tag,
      }),
    )
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
  yield* Effect.annotateCurrentSpan({
    'vivid.action.operation_id': saved.operation,
    'vivid.executor.request_id': saved.pause.requestId,
    'vivid.connection.id': row.id,
    'vivid.operation.id': saved.operation,
    'vivid.executor.request': saved.pause.requestId,
    'vivid.executor.principal': row.executorPrincipal,
  })
  const resumed = yield* operationsOf(row).pipe(
    Effect.flatMap((operation) =>
      operation.resume({ pause: saved.pause, response, effect: action.effect }),
    ),
    observeFailures('http'),
    Effect.result,
  )
  let result = Result.isSuccess(resumed)
    ? resumed.success
    : ExecutorCallOutcome.cases.OutcomeUnknown.make({})
  if (ExecutorCallOutcome.guards.Paused(result) && IntegrationPause.guards.Approval(result.pause)) {
    const resolved = yield* approve(actor, {
      action: ProposedAction.make({
        summary: action.summary,
        rationale: action.rationale,
        effect: action.effect,
        target: action.target,
        continuation: { pause: result.pause, operation: saved.operation },
      }),
      pause: result.pause,
      basis:
        response.action === 'accept' && IntegrationPause.guards.Approval(saved.pause)
          ? 'PersonApproved'
          : 'Read',
    })
    if (Result.isFailure(resolved)) return IntegrationAnswerOutcome.cases.Waiting.make({})
    result = resolved.success
  }
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
    Paused: Effect.fn('IntegrationAsks.nextPause')(function* ({ pause: next }) {
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
    Rejected: ({ message, problems }) =>
      Effect.succeed(
        response.action === 'accept'
          ? IntegrationAnswerOutcome.cases.Rejected.make({ message, problems })
          : declined(response),
      ),
  })
  yield* record(action, outcome)
  yield* Effect.annotateCurrentSpan('vivid.integration.outcome', outcome._tag)
  yield* Effect.logInfo(Message.integrationAnswer).pipe(
    Effect.annotateLogs({
      'vivid.connection.id': row.id,
      'vivid.operation.id': saved.operation,
      'vivid.integration.outcome': outcome._tag,
    }),
  )
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
    Rejected: ({ message }) => message,
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
      | Database
      | ConnectionStore
      | Executor
      | ExecutorMembers
      | ApprovalStore
      | InputStore
      | Audit
      | Gate
    >()
    return IntegrationAnswers.of({
      approve: (actor, input) => approve(actor, input).pipe(Effect.provide(context)),
      settle: (action, outcome) => record(action, outcome).pipe(Effect.provide(context)),
      pause: (actor, action) => pause(actor, action).pipe(Effect.provide(context)),
      answer: (actor, action, response) =>
        answer(actor, action, response).pipe(Effect.provide(context)),
    })
  }),
)
