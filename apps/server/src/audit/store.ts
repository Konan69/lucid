import { desc } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  AuditEntry,
  AuditEntryId,
  AuditEvent,
  DatabaseFailure,
  PersonId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { inWorkspace, isAdmin, loadSummaries, ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored } from '../database/client.ts'
import { auditEntries } from './tables.ts'

const Row = createSelectSchema(auditEntries, {
  id: AuditEntryId,
  personId: PersonId,
  threadId: Schema.NullOr(ThreadId),
  event: AuditEvent,
  by: AuditEntry.fields.by,
})
const decodeRow = decodeStored(Row, 'Audit entry')

/** A role grants the Company record to admins; members still see only their own entries. */
export const loadAudit = Effect.fn('Audit.load')(function* (actor: Actor) {
  const database = yield* Database
  const scope = Workspace.match(actor.workspace, {
    Personal: () => ownedHere(auditEntries, actor),
    Company: ({ role }) =>
      isAdmin(role) ? inWorkspace(auditEntries, actor) : ownedHere(auditEntries, actor),
  })
  const rows = yield* database.run(
    database
      .select()
      .from(auditEntries)
      .where(scope)
      .orderBy(desc(auditEntries.at), desc(auditEntries.id)),
  )
  const records = yield* Effect.forEach(rows, decodeRow)
  const people = yield* loadSummaries(records.map((row) => row.personId))
  const entries = yield* Effect.forEach(records, (row) => {
    const person = people.get(row.personId)
    if (person === undefined)
      return Effect.fail(new DatabaseFailure({ message: 'Audit actor is missing' }))
    return Effect.succeed(
      AuditEntry.make({
        id: row.id,
        at: row.at,
        actor: person,
        by: row.by,
        threadId: row.threadId,
        event: row.event,
      }),
    )
  })
  return { entries }
})
