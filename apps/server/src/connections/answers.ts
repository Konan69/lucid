import type { GateBasis } from '../approvals/gate.ts'
import type { ExecutorCallOutcome } from './executor.ts'
import { Context, Effect, type Result } from 'effect'
import type {
  IntegrationAnswerOutcome,
  IntegrationPause,
  IntegrationResult,
  IntegrationResponse,
  ProposedAction,
  NotFound,
  InvalidRequest,
  Conflict,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/** Both operations retain the Connection's caller and the original journal identity. */
export interface IntegrationAnswersService {
  readonly approve: (
    actor: Actor,
    input: {
      readonly action: ProposedAction
      readonly pause: IntegrationPause
      readonly basis: GateBasis
    },
  ) => Effect.Effect<
    Result.Result<typeof ExecutorCallOutcome.Type, IntegrationResult>,
    NotFound | InvalidRequest | DatabaseInfrastructureError
  >

  readonly pause: (
    actor: Actor,
    action: ProposedAction,
  ) => Effect.Effect<IntegrationResult, NotFound | InvalidRequest | DatabaseInfrastructureError>
  readonly settle: (
    action: ProposedAction,
    outcome: IntegrationAnswerOutcome,
  ) => Effect.Effect<void, NotFound | DatabaseInfrastructureError>
  readonly answer: (
    actor: Actor,
    action: ProposedAction,
    response: IntegrationResponse,
  ) => Effect.Effect<
    IntegrationAnswerOutcome,
    NotFound | InvalidRequest | Conflict | DatabaseInfrastructureError
  >
}

/** The continuation bridge owns external resumption, while existing stores own the Person's questions. */
export class IntegrationAnswers extends Context.Service<
  IntegrationAnswers,
  IntegrationAnswersService
>()('vivid/IntegrationAnswers') {}
