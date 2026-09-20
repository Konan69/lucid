import { and, desc, eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  Company,
  Conflict,
  Forbidden,
  InvitationResponse,
  Membership,
  NotFound,
  type PersonId,
  type SessionId,
  type CreateCompanyRequest,
  type InviteMembershipRequest,
} from '@vivid/contracts'
import {
  Database,
  type DatabaseInfrastructureError,
  type PersistedFields,
} from '../database/client.ts'
import { sessionTable } from '../auth/tables.ts'
import { companyTable, invitationTable, membershipTable } from './tables.ts'

/** The columns a Company's wire form is made of; the row also carries logo, metadata and dates. */
const companyFields = (row: typeof companyTable.$inferSelect): PersistedFields => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
})

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: PersistedFields) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new Conflict({ message: 'Stored Company data is invalid' })),
  )

type CompanyStoreError = DatabaseInfrastructureError | Conflict | Forbidden | NotFound

export interface CompanyStoreService {
  readonly list: (personId: PersonId) => Effect.Effect<ReadonlyArray<Company>, CompanyStoreError>
  readonly create: (
    personId: PersonId,
    sessionId: SessionId,
    request: CreateCompanyRequest,
  ) => Effect.Effect<Company, CompanyStoreError>
  readonly invite: (
    personId: PersonId,
    companyId: Company['id'],
    role: string,
    request: InviteMembershipRequest,
  ) => Effect.Effect<InvitationResponse, CompanyStoreError>
  readonly accept: (
    personId: PersonId,
    personEmail: string,
    sessionId: SessionId,
    invitationId: string,
  ) => Effect.Effect<Membership, CompanyStoreError>
}

export class CompanyStore extends Context.Service<CompanyStore, CompanyStoreService>()(
  'vivid/CompanyStore',
) {}

/** Lists Companies through memberships, keeping membership rows out of the wire response. */
const makeList = (database: Database.Service) =>
  Effect.fn('CompanyStore.list')(function* (personId: PersonId) {
    const rows = yield* database.run(
      database
        .select({ company: companyTable })
        .from(membershipTable)
        .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
        .where(eq(membershipTable.userId, personId))
        .orderBy(desc(companyTable.createdAt)),
    )
    return yield* Effect.forEach(rows, (row) => decode(Company, companyFields(row.company)))
  })

/** Creates the Company, owner Membership, and active session as one transaction. */
const makeCreate = (database: Database.Service) =>
  Effect.fn('CompanyStore.create')(function* (
    personId: PersonId,
    sessionId: SessionId,
    request: CreateCompanyRequest,
  ) {
    const existing = yield* database.run(
      database
        .select({ id: companyTable.id })
        .from(companyTable)
        .where(eq(companyTable.slug, request.slug))
        .limit(1),
    )
    if (existing.length > 0)
      return yield* Effect.fail(new Conflict({ message: 'Company slug is already in use' }))
    const companyId = crypto.randomUUID()
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const inserted = yield* tx
          .insert(companyTable)
          .values({ id: companyId, name: request.name, slug: request.slug })
          .returning()
        yield* tx
          .insert(membershipTable)
          .values({ id: crypto.randomUUID(), companyId, userId: personId, role: 'owner' })
        yield* tx
          .update(sessionTable)
          .set({ activeCompanyId: companyId })
          .where(eq(sessionTable.id, sessionId))
        return inserted
      }),
    )
    const row = rows[0]
    if (row === undefined)
      return yield* Effect.fail(new Conflict({ message: 'Company could not be created' }))
    return yield* decode(Company, companyFields(row))
  })

/** Adds a pending Membership after checking the caller's Company role. */
const makeInvite = (database: Database.Service) =>
  Effect.fn('CompanyStore.invite')(function* (
    personId: PersonId,
    companyId: Company['id'],
    role: string,
    request: InviteMembershipRequest,
  ) {
    if (role !== 'owner' && role !== 'admin')
      return yield* Effect.fail(
        new Forbidden({ message: 'Only Company administrators can invite' }),
      )
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .insert(invitationTable)
        .values({
          id: crypto.randomUUID(),
          companyId,
          email: request.email,
          role: request.role,
          status: 'pending',
          expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
          inviterId: personId,
        })
        .returning(),
    )
    const row = rows[0]
    if (row === undefined)
      return yield* Effect.fail(new Conflict({ message: 'Invitation could not be created' }))
    return yield* decode(InvitationResponse, {
      id: row.id,
      companyId,
      email: row.email,
      role: row.role,
      status: row.status,
    })
  })

/** Accepts an invitation and activates the new Company on the caller's session. */
const makeAccept = (database: Database.Service) =>
  Effect.fn('CompanyStore.accept')(function* (
    personId: PersonId,
    personEmail: string,
    sessionId: SessionId,
    invitationId: string,
  ) {
    const rows = yield* database.run(
      database.select().from(invitationTable).where(eq(invitationTable.id, invitationId)).limit(1),
    )
    const invitation = rows[0]
    if (invitation === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Invitation not found' }))
    const now = yield* Clock.currentTimeMillis
    if (
      invitation.status !== 'pending' ||
      invitation.expiresAt.getTime() < now ||
      invitation.email.toLowerCase() !== personEmail.toLowerCase()
    ) {
      return yield* Effect.fail(
        new Forbidden({ message: 'Invitation is not valid for this Person' }),
      )
    }
    const existing = yield* database.run(
      database
        .select({ id: membershipTable.id })
        .from(membershipTable)
        .where(
          and(
            eq(membershipTable.companyId, invitation.companyId),
            eq(membershipTable.userId, personId),
          ),
        )
        .limit(1),
    )
    if (existing.length > 0)
      return yield* Effect.fail(new Conflict({ message: 'Person is already a Member' }))
    const inserted = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const members = yield* tx
          .insert(membershipTable)
          .values({
            id: crypto.randomUUID(),
            companyId: invitation.companyId,
            userId: personId,
            role: invitation.role,
          })
          .returning()
        yield* tx
          .update(invitationTable)
          .set({ status: 'accepted' })
          .where(eq(invitationTable.id, invitation.id))
        yield* tx
          .update(sessionTable)
          .set({ activeCompanyId: invitation.companyId })
          .where(eq(sessionTable.id, sessionId))
        return members
      }),
    )
    const member = inserted[0]
    if (member === undefined)
      return yield* Effect.fail(new Conflict({ message: 'Membership could not be created' }))
    return yield* decode(Membership, {
      id: member.id,
      companyId: member.companyId,
      personId: member.userId,
      role: member.role,
    })
  })

export const companyStoreLayer = Layer.effect(
  CompanyStore,
  Effect.gen(function* () {
    const database = yield* Database
    return CompanyStore.of({
      list: makeList(database),
      create: makeCreate(database),
      invite: makeInvite(database),
      accept: makeAccept(database),
    })
  }),
)
