import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as NodeCrypto from 'node:crypto'
import { AuditEvent, DatabaseFailure } from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'

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

import { Changes, Topic, topicsOf } from '../live/changes.ts'
import { auditEntries } from './tables.ts'

const encodeEvent = Schema.encodeEffect(AuditEvent)

/** Appends attribution and metadata only; event encoding never persists a credential or Message. */
export const auditLayer = Layer.effect(
  Audit,
  Effect.gen(function* () {
    const database = yield* Database
    const changes = yield* Changes
    return Audit.of({
      /** The workspace and caller supply attribution, never an event payload's claimed identity. */
      record: Effect.fn('Audit.record')(function* (actor, event) {
        if (actor.by === 'vivid' && Option.isNone(actor.threadId))
          return yield* Effect.fail(
            new DatabaseFailure({ message: 'Vivid audit attribution needs a Thread' }),
          )
        const encoded = yield* encodeEvent(event).pipe(
          Effect.mapError(
            () => new DatabaseFailure({ message: 'Audit event could not be encoded' }),
          ),
        )
        yield* database.run(
          database.insert(auditEntries).values({
            id: NodeCrypto.randomUUID(),
            at: yield* Clock.currentTimeMillis,
            personId: actor.person.id,
            companyId: companyColumnOf(actor.workspace),
            by: actor.by,
            threadId: actor.by === 'vivid' ? Option.getOrNull(actor.threadId) : null,
            event: encoded,
          }),
        )
        return yield* changes.publish(
          topicsOf(actor).concat(Option.toArray(Option.map(actor.threadId, Topic.thread))),
        )
      }),
    })
  }),
)
