import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Effect, Schema, Match } from 'effect'
import {
  AccountName,
  ApprovalInvalidation,
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
  SignInSurface,
  Workspace,
} from '@vivid/contracts'
import { inWorkspace, summaryOf, type Actor } from '../auth/access.ts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { changed, Topic } from '../live/changes.ts'
import {
  AccountIdentity,
  ExecutorReferences,
  ExecutorAppId,
  LegacyExecutorReferences,
  migrationPending,
  executorMigrationMessage,
} from './executor.ts'
import { connectionLogo, connectionSite, IMPORTED } from './logo.ts'
import { namedAccounts } from './names.ts'
import { MADE } from './made.ts'
import { connections } from './tables.ts'
import { invalidatePending, usingConnection } from '../approvals/stale.ts'

/** A stored Connection. The retired `label` column (`tables.ts`) is read by nothing, so it is
 * left out of the record here, once, and no caller ever sees it. */
export const storedRowSchema = createSelectSchema(connections, {
  id: ConnectionId,
  service: ServiceId,
  name: Schema.NullOr(AccountName),
  identity: Schema.NullOr(AccountIdentity),
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  executorApp: Schema.NullOr(ExecutorAppId),
  references: Schema.Union([ExecutorReferences, LegacyExecutorReferences]),
  returnsTo: SignInSurface,
  status: Schema.Literals(['ready', 'needs-authorization', 'failed']),
}).mapFields(({ label: _retired, ...fields }) => fields)
const rowSchema = storedRowSchema.mapFields((fields) => ({
  ...fields,
  references: ExecutorReferences,
}))
export type ConnectionRecord = typeof rowSchema.Type
const decodeTrip = Schema.decodeUnknownEffect(Schema.Struct({ id: ConnectionId, person: PersonId }))
/** The one decoder for a stored Connection; every reader of the table goes through it. */
export const decodeStoredRow = decodeStored(storedRowSchema, 'Connection')
const isLegacy = Schema.is(LegacyExecutorReferences)

/** An active Connection selects exactly one app. This unique selection grants no deletion
 * authority; ExecutorAppOwnership separately decides whether its app may be reclaimed.
 */
export function claimedApp(references: ExecutorReferences) {
  if (
    ExecutorReferences.guards.ReconnectRequired(references) ||
    ExecutorReferences.guards.MigrationPending(references)
  )
    return null
  return references.app
}

/** Database decoding performs no I/O or reconciliation. Unprocessed legacy selections project
 * an explicit unavailable state; only the migration pass writes outcomes or asks Executor.
 */
export const decodeRow = Effect.fn('Connections.decodeRow')(function* (
  input: typeof connections.$inferSelect,
) {
  const row = yield* decodeStoredRow(input)
  const references = isLegacy(row.references)
    ? migrationPending(row.references, 'Unattempted')
    : row.references
  if (row.executorApp !== claimedApp(references))
    return yield* new DatabaseFailure({
      message: 'Connection app claim does not match its references',
    })
  if (ExecutorReferences.guards.MigrationPending(references))
    return { ...row, references, status: 'failed' as const, reason: executorMigrationMessage }
  return { ...row, references }
})
export const encodeReferences = encodeStored(ExecutorReferences, 'Connection references')

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
  if (row === undefined) return yield* new NotFound({ message: 'Integration not found' })
  return yield* decodeRow(row)
})

/**
 * The pending sign-in a returning browser belongs to, and the Person who began it.
 *
 * The state on the return is the whole authority: 32 or more unguessable characters that only the
 * browser handed the sign-in address ever held, kept here as a digest (`callbackHash`). So the
 * row it names says whose Integration this is, and nothing about the browser does. It used to be
 * matched against the browser's own Vivid session as well; a phone hands the address to a
 * browser that was never signed in to Vivid, so that return was refused and the Integration never
 * finished (8 October 2026). Better Auth links an account the same way: the Person is read from
 * the stored state (`link.userId` in `parseGenericState`, better-auth 1.7.5 `dist/state.mjs`) and
 * the session is not read at all. Its state cookie is not ported: that guards a callback that
 * signs the visiting browser in, and this one changes nothing for the browser it arrives in.
 *
 * Unknown and consumed state are indistinguishable and never expose a Connection id.
 */
export const callbackTrip = Effect.fn('Connections.callbackTrip')(function* (stateHash: string) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: connections.id, person: connections.personId })
      .from(connections)
      .where(
        and(
          eq(connections.status, 'needs-authorization'),
          sql`${connections.references}->>'_tag' = 'OAuthSigningIn'`,
          sql`${connections.references}->>'stateHash' = ${stateHash}`,
        ),
      )
      .limit(2),
  )
  const row = rows[0]
  if (rows.length !== 1 || row === undefined)
    return yield* new NotFound({ message: 'Integration sign-in not found' })
  return yield* decodeTrip(row).pipe(
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
    site: connectionSite(row.service),
    name: row.name,
    identity: row.identity,
    account,
    origin: connectionOrigin(row.service),
    ownership:
      row.companyId === null
        ? ConnectionOwnership.cases.Personal.make({ owner: summaryOf(actor.person) })
        : ConnectionOwnership.cases.Shared.make({}),
    state: yield* stateOf(row),
    createdAt: row.createdAt,
  })
})

/** Only catalogue services support allocating another account from Settings. */
function connectionOrigin(service: ServiceId): Connection['origin'] {
  if (service.startsWith(MADE)) return 'Made'
  if (service.startsWith(IMPORTED)) return 'Address'
  return 'Catalogue'
}

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
  if (named === undefined) return yield* new NotFound({ message: 'Integration not found' })
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

/**
 * Compare saved ownership and state before updating, preventing late callbacks and duplicate
 * readiness audits.
 *
 * Every save here is a change to the account's authorization (signed in, signed in again, signed
 * out by the service, failed), so it raises the authorization generation and, in the same
 * transaction, closes every pending Approval asked through this Integration: Allow on one of them
 * would otherwise run under a sign-in the Person was never asked about.
 */
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
  const encoded = yield* encodeReferences(references)
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .update(connections)
        .set({
          references: encoded,
          executorApp: claimedApp(references),
          status,
          reason,
          authorizationGeneration: sql`${connections.authorizationGeneration} + 1`,
          updatedAt: now,
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
        .returning()
      if (rows.length === 0)
        return yield* new Conflict({
          message: 'This integration changed before authorization finished; reload it.',
        })
      const saved = yield* decodeRow(yield* returned(rows, 'Connection'))
      yield* invalidatePending(
        tx,
        usingConnection(saved.id),
        ApprovalInvalidation.cases.ConnectionChanged.make({
          connectionId: saved.id,
          generation: saved.authorizationGeneration,
        }),
      )
      return saved
    }),
  )
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
    return yield* new Conflict({
      message: 'This integration changed while it was being named; reload it.',
    })
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
  if (rows.length === 0) return yield* new NotFound({ message: 'Integration not found' })
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})

/** The latest client trip owns the return surface. A pending shared authorization also retains
 * its resuming admin before provider access. A ready account opens no trip and is not written. Compare the observed
 * revision to refuse concurrent changes rather than transfer another trip's authority.
 */
export const retainTrip = Effect.fn('Connections.retainTrip')(function* (
  actor: Actor,
  row: ConnectionRecord,
  from: SignInSurface,
) {
  // A ready account has no new grant to attribute; only a pending trip transfers its initiator.
  const personId = row.status === 'needs-authorization' ? actor.person.id : row.personId
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(connections)
      .set({
        personId,
        returnsTo: from,
        updatedAt: yield* Clock.currentTimeMillis,
      })
      .where(
        and(
          eq(connections.id, row.id),
          row.companyId === null
            ? isNull(connections.companyId)
            : eq(connections.companyId, row.companyId),
          eq(connections.personId, row.personId),
          eq(connections.updatedAt, row.updatedAt),
          eq(connections.status, row.status),
        ),
      )
      .returning(),
  )
  if (rows.length === 0)
    return yield* new Conflict({ message: 'This integration changed before resume; reload it.' })
  return yield* decodeRow(yield* returned(rows, 'Connection'))
})
