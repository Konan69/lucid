import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as NodeCrypto from 'node:crypto'
import { AuditEvent, DatabaseFailure, PersonId, CompanyId, ThreadId } from '@vivid/contracts'
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

import { Changes, Topic } from '../live/changes.ts'
import { auditEntries } from './tables.ts'

const encodeEvent = Schema.encodeEffect(AuditEvent)

/** Background settlement uses stored attribution without inventing a live Company Membership. */
export const AuditAttribution = Schema.Struct({
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  by: Schema.Literals(['person', 'vivid']),
  threadId: Schema.NullOr(ThreadId),
})
export type AuditAttribution = typeof AuditAttribution.Type

/** Appends metadata and wakes readers; explicit Thread attribution also covers a Person's decision. */
export const recordAudit = Effect.fn('Audit.append')(function* (
  attribution: AuditAttribution,
  event: AuditEvent,
) {
  const database = yield* Database
  const encoded = yield* encodeEvent(event).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Audit event could not be encoded' })),
  )
  yield* database.run(
    database.insert(auditEntries).values({
      id: NodeCrypto.randomUUID(),
      at: yield* Clock.currentTimeMillis,
      personId: attribution.personId,
      companyId: attribution.companyId,
      by: attribution.by,
      threadId: attribution.threadId,
      event: encoded,
    }),
  )
  const topics = [Topic.person(attribution.personId)].concat(
    Option.toArray(Option.map(Option.fromNullishOr(attribution.companyId), Topic.company)),
    Option.toArray(Option.map(Option.fromNullishOr(attribution.threadId), Topic.thread)),
  )
  return yield* (yield* Changes).publish(topics)
})

/** Request context supplies attribution; background recovery calls the same append boundary directly. */
export const auditLayer = Layer.effect(
  Audit,
  Effect.gen(function* () {
    const context = yield* Effect.context<Database | Changes>()
    return Audit.of({
      /** A decision can carry its stored Thread even though it was made by a signed-in Person. */
      record: Effect.fn('Audit.record')(function* (actor, event) {
        if (actor.by === 'vivid' && Option.isNone(actor.threadId))
          return yield* Effect.fail(
            new DatabaseFailure({ message: 'Vivid audit attribution needs a Thread' }),
          )
        return yield* Effect.provide(
          recordAudit(
            AuditAttribution.make({
              personId: actor.person.id,
              companyId: companyColumnOf(actor.workspace),
              by: actor.by,
              threadId: Option.getOrNull(actor.threadId),
            }),
            event,
          ),
          context,
        )
      }),
    })
  }),
)
