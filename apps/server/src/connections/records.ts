import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Effect, Schema } from 'effect'
import {
  CompanyId,
  Connection,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  Conflict,
  DatabaseFailure,
  NotFound,
  PersonId,
  ServiceId,
  Workspace,
} from '@vivid/contracts'
import { inWorkspace, summaryOf, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { changed, Topic } from '../live/changes.ts'
import { ExecutorReferences } from './executor.ts'
import { connections } from './tables.ts'

const rowSchema = createSelectSchema(connections, {
  id: ConnectionId,
  service: ServiceId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  references: ExecutorReferences,
  status: Schema.Literals(['ready', 'needs-authorization', 'failed']),
})
export type ConnectionRecord = typeof rowSchema.Type
const decodeRow = decodeStored(rowSchema, 'Connection')
export const encodeReferences = Schema.encodeSync(ExecutorReferences)

/** Personal accounts follow their Person across workspaces; Company accounts stay in their Company. */
const usable = (actor: Actor) => {
  const own = inWorkspace(connections, { ...actor, workspace: Workspace.cases.Personal.make({}) })
  return Workspace.match(actor.workspace, {
    Personal: () => own,
    Company: () => or(own, inWorkspace(connections, actor)),
  })
}

/** Scope every inventory read before decoding, so foreign identifiers reveal nothing. */
export const listRecords = Effect.fn('Connections.listRecords')(function* (actor: Actor) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(connections).where(usable(actor)).orderBy(desc(connections.createdAt)),
  )
  return yield* Effect.forEach(rows, decodeRow)
})

/** Callback authority is the Person who began authorization, independently of their current workspace. */
export const getRecord = Effect.fn('Connections.getRecord')(function* (
  actor: Actor,
  id: ConnectionId,
  callback: boolean,
) {
  const database = yield* Database
  const scope = callback ? eq(connections.personId, actor.person.id) : usable(actor)
  const rows = yield* database.run(
    database
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), scope))
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Connection not found' }))
  return yield* decodeRow(row)
})

/** Stored failure reasons are required only for failed state; invalid legacy rows fail explicitly. */
const stateOf = (row: ConnectionRecord) => {
  if (row.status === 'ready') return Effect.succeed(ConnectionState.cases.Ready.make({}))
  if (row.status === 'needs-authorization')
    return Effect.succeed(ConnectionState.cases.NeedsAuthorization.make({}))
  if (row.reason === null)
    return Effect.fail(new DatabaseFailure({ message: 'Failed Connection has no reason' }))
  return Effect.succeed(ConnectionState.cases.Failed.make({ reason: row.reason }))
}

/** Personal ownership always refers to the acting owner, never to a Company's administrator. */
export const publicConnection = Effect.fn('Connections.public')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  return Connection.make({
    id: row.id,
    service: row.service,
    serviceName: row.serviceName,
    label: row.label,
    ownership:
      row.companyId === null
        ? ConnectionOwnership.cases.Personal.make({ owner: summaryOf(actor.person) })
        : ConnectionOwnership.cases.Shared.make({}),
    state: yield* stateOf(row),
    createdAt: row.createdAt,
  })
})

/** Publish to the persisted Company too, including callbacks after a workspace switch. */
export const recordChanged = Effect.fn('Connections.changed')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  const extra = row.companyId === null ? [] : [Topic.company(row.companyId)]
  yield* changed(actor, ...extra)
})

/** Compare saved ownership and state before updating, preventing late callbacks and duplicate readiness audits. */
export const saveState = Effect.fn('Connections.saveState')(function* (
  row: ConnectionRecord,
  state: ConnectionState,
  references: ExecutorReferences,
) {
  const database = yield* Database
  const status = ConnectionState.match(state, {
    Ready: () => 'ready',
    NeedsAuthorization: () => 'needs-authorization',
    Failed: () => 'failed',
  })
  const reason = ConnectionState.match(state, {
    Ready: () => null,
    NeedsAuthorization: () => null,
    Failed: (failure) => failure.reason,
  })
  const rows = yield* database.run(
    database
      .update(connections)
      .set({
        references: encodeReferences(references),
        status,
        reason,
        updatedAt: yield* Clock.currentTimeMillis,
      })
      .where(
        and(
          eq(connections.id, row.id),
          eq(connections.personId, row.personId),
          eq(connections.status, row.status),
          eq(connections.updatedAt, row.updatedAt),
          row.companyId === null
            ? isNull(connections.companyId)
            : eq(connections.companyId, row.companyId),
        ),
      )
      .returning(),
  )
  if (rows.length === 0)
    return yield* Effect.fail(
      new Conflict({
        message: 'This Connection changed before authorization finished; reload it.',
      }),
    )
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})
