import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AuditEvent } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

export interface AuditService {
  /**
   * Writes one line of the audit record for what `actor` just did. The record says what happened
   * and to which service, never the content it happened to: an admin reading it learns that a
   * Member's Vivid sent an email, not what the email said (docs/22, rule 9).
   */
  readonly record: (
    actor: Actor,
    event: AuditEvent,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
}

/** Implemented in `audit/record.ts` by `auditLayer`. */
export class Audit extends Context.Service<Audit, AuditService>()('vivid/Audit') {}
