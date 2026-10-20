import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { PersonId, type CompanyId, type SessionId } from '@vivid/contracts'
import { decodeStored, returned, type Database } from '../database/client.ts'
import { sessionTable } from './tables.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
const decodeSessionOwner = decodeStored(Schema.Struct({ personId: PersonId }), 'session owner')

/**
 * Companies authorizes the movement before calling. Auth owns the session write and restricts
 * it to the named Person. The supplied transaction keeps membership checks and notices atomic.
 * A vanished session has no owner to notify and is a successful no-op, as before.
 */
export const moveSession = Effect.fn('Auth.moveSession')(function* (
  tx: Transaction,
  personId: PersonId,
  sessionId: SessionId,
  companyId: Option.Option<CompanyId>,
) {
  const rows = yield* tx
    .update(sessionTable)
    .set({ activeCompanyId: Option.getOrNull(companyId) })
    .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, personId)))
    .returning({ personId: sessionTable.userId })
  if (rows.length === 0) return Option.none<PersonId>()
  const owner = yield* decodeSessionOwner(yield* returned(rows, 'session'))
  return Option.some(owner.personId)
})

/** A removed Member leaves only this Company in every session, within the removal transaction. */
export const leaveCompanySessions = Effect.fn('Auth.leaveCompanySessions')(function* (
  tx: Transaction,
  personId: PersonId,
  companyId: CompanyId,
) {
  yield* tx
    .update(sessionTable)
    .set({ activeCompanyId: null })
    .where(and(eq(sessionTable.userId, personId), eq(sessionTable.activeCompanyId, companyId)))
})
