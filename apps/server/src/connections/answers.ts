import { Context, Effect } from 'effect'
import type {
  IntegrationAnswerOutcome,
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
  readonly pause: (
    actor: Actor,
    action: ProposedAction,
  ) => Effect.Effect<IntegrationResult, NotFound | InvalidRequest | DatabaseInfrastructureError>
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
