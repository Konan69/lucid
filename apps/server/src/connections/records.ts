import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Effect, Schema, Match } from 'effect'
import {
  AccountName,
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
import { AccountIdentity, ExecutorReferences } from './executor.ts'
import { connectionLogo, IMPORTED } from './logo.ts'
import { namedAccounts } from './names.ts'
import { connections } from './tables.ts'

/** A stored Connection. The retired `label` column (`tables.ts`) is read by nothing, so it is
 * left out of the record here, once, and no caller ever sees it. */
const rowSchema = createSelectSchema(connections, {
  id: ConnectionId,
  service: ServiceId,
  name: Schema.NullOr(AccountName),
  identity: Schema.NullOr(AccountIdentity),
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  references: ExecutorReferences,
  status: Schema.Literals(['ready', 'needs-authorization', 'failed']),
}).mapFields(({ label: _retired, ...fields }) => fields)
export type ConnectionRecord = typeof rowSchema.Type
const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId)
/** The one decoder for a stored Connection; every reader of the table goes through it. */
export const decodeRow = decodeStored(rowSchema, 'Connection')
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

/** Callback authority follows the Person who most recently began/resumed authorization across workspaces. */
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
    return yield* Effect.fail(new NotFound({ message: 'Integration not found' }))
  return yield* decodeRow(row)
})

/** A fixed callback resolves only the initiating Person's exact pending hash. Unknown,
 * foreign, and consumed state are indistinguishable and never expose another Connection id.
 */
export const callbackId = Effect.fn('Connections.callbackId')(function* (
  actor: Actor,
  stateHash: string,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.personId, actor.person.id),
          eq(connections.status, 'needs-authorization'),
          sql`${connections.references}->>'_tag' = 'OAuthSigningIn'`,
          sql`${connections.references}->>'stateHash' = ${stateHash}`,
        ),
      )
      .limit(2),
  )
  const row = rows[0]
  if (rows.length !== 1 || row === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Integration sign-in not found' }))
  return yield* decodeConnectionId(row.id).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Invalid integration identity' })),
  )
})

/** Stored failure reasons are required only for failed state; invalid legacy rows fail explicitly. */
export const stateOf = (row: ConnectionRecord) =>
  Match.value(row.status).pipe(
    Match.when('ready', () => Effect.succeed(ConnectionState.cases.Ready.make({}))),
    Match.when('needs-authorization', () =>
      Effect.succeed(ConnectionState.cases.NeedsAuthorization.make({})),
    ),
    Match.when('failed', () =>
      row.reason === null
        ? Effect.fail(new DatabaseFailure({ message: 'Failed integration has no reason' }))
        : Effect.succeed(ConnectionState.cases.Failed.make({ reason: row.reason })),
    ),
    Match.exhaustive,
  )

/**
 * One row as a Person's screens read it, under the name it has among this Actor's accounts.
 * Personal ownership always refers to the acting owner, never to a Company's administrator.
 */
export const connectionOf = Effect.fn('Connections.connectionOf')(function* (
  actor: Actor,
  row: ConnectionRecord,
  account: string,
) {
  return Connection.make({
    id: row.id,
    service: row.service,
    serviceName: row.serviceName,
    mark: connectionLogo(row.service),
    name: row.name,
    identity: row.identity,
    account,
    origin: row.service.startsWith(IMPORTED) ? 'Address' : 'Catalogue',
    ownership:
      row.companyId === null
        ? ConnectionOwnership.cases.Personal.make({ owner: summaryOf(actor.person) })
        : ConnectionOwnership.cases.Shared.make({}),
    state: yield* stateOf(row),
    createdAt: row.createdAt,
  })
})

/**
 * One Connection for an answer that carries only it (a step, a rename). Its name is decided among
 * everything the Actor can use, so it is the name the list and Vivid give it; a row that is no
 * longer among them has been removed, and is not found.
 */
export const publicConnection = Effect.fn('Connections.public')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  const named = namedAccounts(yield* listRecords(actor)).find((entry) => entry.row.id === row.id)
  if (named === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Integration not found' }))
  return yield* connectionOf(actor, row, named.account)
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
        message: 'This integration changed before authorization finished; reload it.',
      }),
    )
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})

/**
 * Writes who the service says signed in, once Executor has said. It is written only onto the row
 * the service was asked about: `updated_at` is the revision of a Connection's authorization
 * (`saveState` compares it), so a row whose authorization changed while the service was being
 * asked is left alone, and its identity is asked for again when it next becomes ready.
 *
 * The revision is compared and never moved. An identity is not part of the authorization, and a
 * write that moved the revision would make a sign-in that is completing at that moment fail its
 * own comparison after the service had already accepted it.
 */
export const saveIdentity = Effect.fn('Connections.saveIdentity')(function* (
  row: ConnectionRecord,
  identity: AccountIdentity,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(connections)
      .set({ identity })
      .where(and(eq(connections.id, row.id), eq(connections.updatedAt, row.updatedAt)))
      .returning(),
  )
  if (rows.length === 0)
    return yield* Effect.fail(
      new Conflict({ message: 'This integration changed while it was being named; reload it.' }),
    )
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})

/**
 * Writes what the Person calls the account, or takes the name away with null. Scoped to the row's
 * own owner like every other write here; the row's state and references are left alone.
 *
 * `updated_at` is left alone too. It is the revision `saveState` compares, and a name is not
 * part of the authorization: a Person naming an account while its sign-in is completing would
 * otherwise make that completion fail its comparison after the service had accepted it, and the
 * account would stay "not finished".
 */
export const saveName = Effect.fn('Connections.saveName')(function* (
  row: ConnectionRecord,
  name: AccountName | null,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(connections)
      .set({ name })
      .where(
        and(
          eq(connections.id, row.id),
          eq(connections.personId, row.personId),
          row.companyId === null
            ? isNull(connections.companyId)
            : eq(connections.companyId, row.companyId),
        ),
      )
      .returning(),
  )
  if (rows.length === 0)
    return yield* Effect.fail(new NotFound({ message: 'Integration not found' }))
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})

/** Shared ownership is the Company; person_id attributes its current authorization attempt. Persist
 * the resuming admin before provider access so the returned grant cannot stay bound to its creator.
 * Compare the observed revision to refuse a concurrent change instead of transferring its authority.
 */
export const retainResumer = Effect.fn('Connections.retainResumer')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  if (row.companyId === null || row.personId === actor.person.id) return row
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(connections)
      .set({
        personId: actor.person.id,
        updatedAt: yield* Clock.currentTimeMillis,
      })
      .where(
        and(
          eq(connections.id, row.id),
          eq(connections.companyId, row.companyId),
          eq(connections.personId, row.personId),
          eq(connections.updatedAt, row.updatedAt),
          eq(connections.status, row.status),
        ),
      )
      .returning(),
  )
  if (rows.length === 0)
    return yield* Effect.fail(
      new Conflict({ message: 'This integration changed before resume; reload it.' }),
    )
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})
