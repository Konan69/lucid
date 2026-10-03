import { and, asc, desc, eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  Company,
  CompanyId,
  CompanyMembership,
  Conflict,
  Forbidden,
  Invitation,
  InvitationId,
  InvitationPreview,
  InvitationStatus,
  Member,
  MembershipId,
  NotFound,
  PersonId,
  Role,
  type InviteMembershipRequest,
  type PersonSummary,
  type SessionId,
} from '@vivid/contracts'
import { loadSummaries } from '../auth/access.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { companyTable, invitationTable, membershipTable } from './tables.ts'

type DatabaseService = Database['Service']
type CompanyStoreError = DatabaseInfrastructureError | Conflict | Forbidden | NotFound

const INVITATION_LASTS_MS = 7 * 24 * 60 * 60 * 1000

const decodeCompany = decodeStored(Company, 'Company')
const decodeMembership = decodeStored(CompanyMembership, 'Membership')
const decodeMember = decodeStored(Member, 'Member')
const decodeInvitation = decodeStored(Invitation, 'invitation')
const decodePreview = decodeStored(InvitationPreview, 'invitation')

/** A Membership row with the ids branded, for the checks that follow a lookup. */
const StoredMembership = Schema.Struct({
  id: MembershipId,
  companyId: CompanyId,
  personId: PersonId,
  role: Role,
})
const decodeStoredMembership = decodeStored(StoredMembership, 'Membership')

/** An invitation row as stored. `status` is what was written; expiry is judged when it is read. */
const StoredInvitation = Schema.Struct({
  id: InvitationId,
  companyId: CompanyId,
  email: Schema.String,
  role: Role,
  status: InvitationStatus,
  expiresAt: Schema.Number,
  inviterId: PersonId,
})
interface StoredInvitation extends Schema.Schema.Type<typeof StoredInvitation> {}
const decodeStoredInvitation = decodeStored(StoredInvitation, 'invitation')

/** What an administrative change did, so the caller can tell the People it touched. */
export interface MemberChange {
  readonly member: Member
  readonly companyId: CompanyId
}

export interface CompanyStoreService {
  /** Every Company a Person belongs to, with their role in each, newest first. */
  readonly memberships: (
    personId: PersonId,
  ) => Effect.Effect<ReadonlyArray<CompanyMembership>, CompanyStoreError>
  /** Creates a Company with its creator as owner. The session is not moved here. */
  readonly create: (personId: PersonId, name: string) => Effect.Effect<Company, CompanyStoreError>
  /** Points a session at a Company the Person belongs to, or back at their own space. */
  readonly enter: (
    personId: PersonId,
    sessionId: SessionId,
    companyId: Option.Option<CompanyId>,
  ) => Effect.Effect<void, CompanyStoreError>
  readonly members: (
    companyId: CompanyId,
  ) => Effect.Effect<ReadonlyArray<Member>, CompanyStoreError>
  readonly invitations: (
    companyId: CompanyId,
  ) => Effect.Effect<ReadonlyArray<Invitation>, CompanyStoreError>
  readonly invite: (
    inviter: PersonId,
    companyId: CompanyId,
    request: InviteMembershipRequest,
  ) => Effect.Effect<Invitation, CompanyStoreError>
  readonly revoke: (
    companyId: CompanyId,
    id: InvitationId,
  ) => Effect.Effect<void, CompanyStoreError>
  readonly preview: (id: InvitationId) => Effect.Effect<InvitationPreview, CompanyStoreError>
  /** Turns an invitation into a Membership for the Person it was sent to. */
  readonly accept: (
    person: { readonly id: PersonId; readonly email: string },
    id: InvitationId,
  ) => Effect.Effect<MemberChange, CompanyStoreError>
  readonly changeRole: (
    companyId: CompanyId,
    membershipId: MembershipId,
    role: 'admin' | 'member',
  ) => Effect.Effect<Member, CompanyStoreError>
  /** Removes a Member. Used by an admin for someone else and by a Person for themselves. */
  readonly remove: (
    companyId: CompanyId,
    membershipId: MembershipId,
  ) => Effect.Effect<Member, CompanyStoreError>
  /** The Person an email address belongs to, when they already have an account. */
  readonly personByEmail: (
    email: string,
  ) => Effect.Effect<Option.Option<PersonId>, CompanyStoreError>
}

export class CompanyStore extends Context.Service<CompanyStore, CompanyStoreService>()(
  'vivid/CompanyStore',
) {}

/** Email addresses are compared without case; this is the form stored and searched. */
const normalized = (email: string) => email.trim().toLowerCase()

/**
 * A URL-safe handle from a name, with a short random tail so two Companies of the same name never
 * collide and nobody has to choose a handle to create one.
 */
const slugFor = (name: string) => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const tail = crypto.randomUUID().slice(0, 6)
  return base.length === 0 ? tail : `${base}-${tail}`
}

/** A stored invitation's standing now: a pending one past its time has expired. */
const standing = (invitation: StoredInvitation, now: number): InvitationStatus =>
  invitation.status === 'pending' && invitation.expiresAt < now ? 'expired' : invitation.status

const makeMemberships = (database: DatabaseService) =>
  Effect.fn('CompanyStore.memberships')(function* (personId: PersonId) {
    const rows = yield* database.run(
      database
        .select({ company: companyTable, role: membershipTable.role })
        .from(membershipTable)
        .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
        .where(eq(membershipTable.userId, personId))
        .orderBy(desc(companyTable.createdAt)),
    )
    return yield* Effect.forEach(rows, (row) =>
      decodeMembership({
        company: { id: row.company.id, name: row.company.name, slug: row.company.slug },
        role: row.role,
      }),
    )
  })

const makeCreate = (database: DatabaseService) =>
  Effect.fn('CompanyStore.create')(function* (personId: PersonId, name: string) {
    const companyId = crypto.randomUUID()
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const inserted = yield* tx
          .insert(companyTable)
          .values({ id: companyId, name: name.trim(), slug: slugFor(name) })
          .returning()
        yield* tx
          .insert(membershipTable)
          .values({ id: crypto.randomUUID(), companyId, userId: personId, role: 'owner' })
        return inserted
      }),
    )
    const row = yield* returned(rows, 'Company')
    return yield* decodeCompany({ id: row.id, name: row.name, slug: row.slug })
  })

/** One Membership by Company and Person, when it exists. */
const membershipOf = Effect.fn('CompanyStore.membershipOf')(function* (
  database: DatabaseService,
  companyId: CompanyId,
  personId: PersonId,
) {
  const rows = yield* database.run(
    database
      .select()
      .from(membershipTable)
      .where(and(eq(membershipTable.companyId, companyId), eq(membershipTable.userId, personId)))
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined) return Option.none()
  return Option.some(
    yield* decodeStoredMembership({
      id: row.id,
      companyId: row.companyId,
      personId: row.userId,
      role: row.role,
    }),
  )
})

const makeEnter = (database: DatabaseService) =>
  Effect.fn('CompanyStore.enter')(function* (
    personId: PersonId,
    sessionId: SessionId,
    companyId: Option.Option<CompanyId>,
  ) {
    // Not a Member and no such Company are the same answer: nothing confirms a Company exists.
    const allowed = Option.isNone(companyId)
      ? true
      : Option.isSome(yield* membershipOf(database, companyId.value, personId))
    if (!allowed) return yield* Effect.fail(new NotFound({ message: 'Company not found' }))
    return yield* database
      .run(
        database
          .update(sessionTable)
          .set({ activeCompanyId: Option.getOrNull(companyId) })
          .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, personId))),
      )
      .pipe(Effect.asVoid)
  })

const toMember = (
  row: typeof membershipTable.$inferSelect,
  person: { readonly name: string; readonly image: string | null; readonly email: string },
) =>
  decodeMember({
    membershipId: row.id,
    person: { id: row.userId, name: person.name, image: person.image },
    email: person.email,
    role: row.role,
    joinedAt: row.createdAt.getTime(),
  })

const makeMembers = (database: DatabaseService) =>
  Effect.fn('CompanyStore.members')(function* (companyId: CompanyId) {
    const rows = yield* database.run(
      database
        .select({ membership: membershipTable, person: personTable })
        .from(membershipTable)
        .innerJoin(personTable, eq(membershipTable.userId, personTable.id))
        .where(eq(membershipTable.companyId, companyId))
        .orderBy(asc(membershipTable.createdAt)),
    )
    return yield* Effect.forEach(rows, (row) => toMember(row.membership, row.person))
  })

/** The inviter as other People see them, who must exist: the reference cascades. */
const inviterOf = (summaries: ReadonlyMap<PersonId, PersonSummary>, id: PersonId) => {
  const summary = summaries.get(id)
  return summary === undefined
    ? Effect.fail(new NotFound({ message: 'Invitation not found' }))
    : Effect.succeed(summary)
}

const storedInvitation = (row: typeof invitationTable.$inferSelect) =>
  decodeStoredInvitation({
    id: row.id,
    companyId: row.companyId,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt.getTime(),
    inviterId: row.inviterId,
  })

const makeInvitations = (database: DatabaseService) =>
  Effect.fn('CompanyStore.invitations')(function* (companyId: CompanyId) {
    const rows = yield* database.run(
      database
        .select()
        .from(invitationTable)
        .where(and(eq(invitationTable.companyId, companyId), eq(invitationTable.status, 'pending')))
        .orderBy(desc(invitationTable.createdAt)),
    )
    const stored = yield* Effect.forEach(rows, storedInvitation)
    const now = yield* Clock.currentTimeMillis
    const summaries = yield* loadSummaries(stored.map((row) => row.inviterId)).pipe(
      Effect.provideService(Database, database),
    )
    return yield* Effect.forEach(stored, (row) => toInvitation(row, summaries, now))
  })

const toInvitation = Effect.fn('CompanyStore.toInvitation')(function* (
  row: StoredInvitation,
  summaries: ReadonlyMap<PersonId, PersonSummary>,
  now: number,
) {
  return yield* decodeInvitation({
    id: row.id,
    email: row.email,
    role: row.role,
    status: standing(row, now),
    invitedBy: yield* inviterOf(summaries, row.inviterId),
    expiresAt: row.expiresAt,
  })
})

const makePersonByEmail = (database: DatabaseService) =>
  Effect.fn('CompanyStore.personByEmail')(function* (email: string) {
    const rows = yield* database.run(
      database
        .select({ id: personTable.id })
        .from(personTable)
        .where(eq(personTable.email, normalized(email)))
        .limit(1),
    )
    const row = rows[0]
    return row === undefined ? Option.none<PersonId>() : Option.some(PersonId.make(row.id))
  })

const makeInvite = (database: DatabaseService) =>
  Effect.fn('CompanyStore.invite')(function* (
    inviter: PersonId,
    companyId: CompanyId,
    request: InviteMembershipRequest,
  ) {
    const email = normalized(request.email)
    const existing = yield* makePersonByEmail(database)(email)
    if (Option.isSome(existing)) {
      const membership = yield* membershipOf(database, companyId, existing.value)
      if (Option.isSome(membership)) {
        return yield* Effect.fail(new Conflict({ message: 'That Person is already a Member' }))
      }
    }
    const now = yield* Clock.currentTimeMillis
    // One open invitation per address: inviting again replaces the earlier offer, so an old link
    // with a role nobody intends any more cannot still be accepted.
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .update(invitationTable)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(invitationTable.companyId, companyId),
              eq(invitationTable.email, email),
              eq(invitationTable.status, 'pending'),
            ),
          )
        return yield* tx
          .insert(invitationTable)
          .values({
            id: crypto.randomUUID(),
            companyId,
            email,
            role: request.role,
            status: 'pending',
            expiresAt: new Date(now + INVITATION_LASTS_MS),
            inviterId: inviter,
          })
          .returning()
      }),
    )
    const stored = yield* storedInvitation(yield* returned(rows, 'invitation'))
    const summaries = yield* loadSummaries([inviter]).pipe(
      Effect.provideService(Database, database),
    )
    return yield* toInvitation(stored, summaries, now)
  })

const makeRevoke = (database: DatabaseService) =>
  Effect.fn('CompanyStore.revoke')(function* (companyId: CompanyId, id: InvitationId) {
    const rows = yield* database.run(
      database
        .update(invitationTable)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(invitationTable.id, id),
            eq(invitationTable.companyId, companyId),
            eq(invitationTable.status, 'pending'),
          ),
        )
        .returning({ id: invitationTable.id }),
    )
    return rows.length === 0
      ? yield* Effect.fail(new NotFound({ message: 'Invitation not found' }))
      : undefined
  })

/** One invitation with its Company, by id. */
const invitationById = Effect.fn('CompanyStore.invitationById')(function* (
  database: DatabaseService,
  id: InvitationId,
) {
  const rows = yield* database.run(
    database
      .select({ invitation: invitationTable, company: companyTable })
      .from(invitationTable)
      .innerJoin(companyTable, eq(invitationTable.companyId, companyTable.id))
      .where(eq(invitationTable.id, id))
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined) {
    return yield* Effect.fail(new NotFound({ message: 'Invitation not found' }))
  }
  return { invitation: yield* storedInvitation(row.invitation), company: row.company }
})

const makePreview = (database: DatabaseService) =>
  Effect.fn('CompanyStore.preview')(function* (id: InvitationId) {
    const { invitation, company } = yield* invitationById(database, id)
    const now = yield* Clock.currentTimeMillis
    const summaries = yield* loadSummaries([invitation.inviterId]).pipe(
      Effect.provideService(Database, database),
    )
    return yield* decodePreview({
      id: invitation.id,
      company: { id: company.id, name: company.name, slug: company.slug },
      role: invitation.role,
      invitedBy: yield* inviterOf(summaries, invitation.inviterId),
      status: standing(invitation, now),
    })
  })

/** One Member of a Company by their Membership id, or the refusal that it is not there. */
const memberById = Effect.fn('CompanyStore.memberById')(function* (
  database: DatabaseService,
  companyId: CompanyId,
  membershipId: MembershipId,
) {
  const rows = yield* database.run(
    database
      .select({ membership: membershipTable, person: personTable })
      .from(membershipTable)
      .innerJoin(personTable, eq(membershipTable.userId, personTable.id))
      .where(and(eq(membershipTable.id, membershipId), eq(membershipTable.companyId, companyId)))
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined) return yield* Effect.fail(new NotFound({ message: 'Member not found' }))
  return yield* toMember(row.membership, row.person)
})

const makeAccept = (database: DatabaseService) =>
  Effect.fn('CompanyStore.accept')(function* (
    person: { readonly id: PersonId; readonly email: string },
    id: InvitationId,
  ) {
    const { invitation } = yield* invitationById(database, id)
    const now = yield* Clock.currentTimeMillis
    // An invitation is for the address it was sent to. Someone else holding the link learns only
    // what the preview already told them.
    if (standing(invitation, now) !== 'pending' || invitation.email !== normalized(person.email)) {
      return yield* Effect.fail(
        new Forbidden({ message: 'This invitation is not open for your account' }),
      )
    }
    const membershipId = crypto.randomUUID()
    // The claim and the Membership are one transaction, and the claim is conditional: of two
    // accepts racing on one invitation, one creates the Membership and the other gets a conflict.
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const claimed = yield* tx
          .update(invitationTable)
          .set({ status: 'accepted' })
          .where(and(eq(invitationTable.id, id), eq(invitationTable.status, 'pending')))
          .returning({ id: invitationTable.id })
        if (claimed.length === 0) {
          return yield* Effect.fail(new Conflict({ message: 'This invitation was already used' }))
        }
        return yield* tx
          .insert(membershipTable)
          .values({
            id: membershipId,
            companyId: invitation.companyId,
            userId: person.id,
            role: invitation.role,
          })
          .onConflictDoNothing()
      }),
    )
    const member = yield* memberById(
      database,
      invitation.companyId,
      MembershipId.make(membershipId),
    ).pipe(
      Effect.catchTag('NotFound', () =>
        Effect.fail(new Conflict({ message: 'You are already a Member' })),
      ),
    )
    return { member, companyId: invitation.companyId }
  })

/** The owner's standing is not something an admin can change or remove. */
const refuseOwner = (member: Member) =>
  member.role === 'owner'
    ? Effect.fail(new Forbidden({ message: "A Company's owner cannot be changed here" }))
    : Effect.succeed(member)

const makeChangeRole = (database: DatabaseService) =>
  Effect.fn('CompanyStore.changeRole')(function* (
    companyId: CompanyId,
    membershipId: MembershipId,
    role: 'admin' | 'member',
  ) {
    yield* refuseOwner(yield* memberById(database, companyId, membershipId))
    yield* database.run(
      database.update(membershipTable).set({ role }).where(eq(membershipTable.id, membershipId)),
    )
    return yield* memberById(database, companyId, membershipId)
  })

const makeRemove = (database: DatabaseService) =>
  Effect.fn('CompanyStore.remove')(function* (companyId: CompanyId, membershipId: MembershipId) {
    const member = yield* refuseOwner(yield* memberById(database, companyId, membershipId))
    // Their sessions leave the Company with them. `workspaceIn` would refuse it anyway on the next
    // call; clearing it keeps what the session says true.
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.delete(membershipTable).where(eq(membershipTable.id, membershipId))
        yield* tx
          .update(sessionTable)
          .set({ activeCompanyId: null })
          .where(
            and(
              eq(sessionTable.userId, member.person.id),
              eq(sessionTable.activeCompanyId, companyId),
            ),
          )
      }),
    )
    return member
  })

export const companyStoreLayer = Layer.effect(
  CompanyStore,
  Effect.gen(function* () {
    const database = yield* Database
    return CompanyStore.of({
      memberships: makeMemberships(database),
      create: makeCreate(database),
      enter: makeEnter(database),
      members: makeMembers(database),
      invitations: makeInvitations(database),
      invite: makeInvite(database),
      revoke: makeRevoke(database),
      preview: makePreview(database),
      accept: makeAccept(database),
      changeRole: makeChangeRole(database),
      remove: makeRemove(database),
      personByEmail: makePersonByEmail(database),
    })
  }),
)
