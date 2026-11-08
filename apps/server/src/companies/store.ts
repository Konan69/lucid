import { and, asc, desc, eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ApprovalInvalidation,
  Appearance,
  AuditEvent,
  Company,
  CompanyId,
  CompanyMembership,
  Conflict,
  Forbidden,
  Invitation,
  InvitationId,
  InvitationPreview,
  InvitationStatus,
  MailboxUnconfirmed,
  Member,
  MembershipId,
  NotFound,
  PersonId,
  PersonSummary,
  Role,
  type InviteMembershipRequest,
  type SessionId,
} from '@vivid/contracts'
import { askedOfMember, invalidatePending } from '../approvals/stale.ts'
import { appendAudit, AuditAttribution } from '../audit/record.ts'
import { announce, Topic } from '../live/changes.ts'
import { loadSummaries } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { moveSession, leaveCompanySessions } from '../auth/workspace.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { companyTable, invitationTable, membershipTable } from './tables.ts'

type DatabaseService = Database['Service']
type Transaction = Parameters<Parameters<DatabaseService['transaction']>[0]>[0]
type CompanyStoreError = DatabaseInfrastructureError | Conflict | Forbidden | NotFound

const INVITATION_LASTS_MS = 7 * 24 * 60 * 60 * 1000

const decodeCompany = decodeStored(Company, 'Company')
const decodeAppearance = decodeStored(Appearance, 'Appearance')
const decodeMembership = decodeStored(CompanyMembership, 'Membership')
const decodeMember = decodeStored(Member, 'Member')
const decodePreview = decodeStored(InvitationPreview, 'invitation')

/** A Membership row with the ids branded, for the checks that follow a lookup. */
const StoredMembership = Schema.Struct({
  id: MembershipId,
  companyId: CompanyId,
  personId: PersonId,
  role: Role,
})
const decodeStoredMembership = decodeStored(StoredMembership, 'Membership')

/** Transaction row owners are decoded at ingress, independent of the session's workspace. */
const decodePersonId = decodeStored(PersonId, 'Person id')
const decodeOwnedMember = decodeStored(
  Schema.Struct({ companyId: CompanyId, member: Member }),
  'Member',
)
const StoredMailbox = Schema.Struct({ email: Schema.String, verified: Schema.Boolean })
const decodeMailbox = decodeStored(StoredMailbox, 'mailbox')
const decodeSummary = decodeStored(PersonSummary, 'Person')

/** An invitation row as stored. `status` is what was written; expiry is judged when it is read. */
const StoredInvitation = Schema.Struct({
  id: InvitationId,
  companyId: CompanyId,
  email: Schema.String,
  role: Role,
  status: InvitationStatus,
  expiresAt: Schema.Finite,
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
  /** Replaces only the Company's appearance, joining the caller's SQL transaction. */
  readonly setAppearance: (
    companyId: CompanyId,
    appearance: Appearance,
  ) => Effect.Effect<Appearance, DatabaseInfrastructureError>
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
  /**
   * Turns an invitation into a Membership for the Person it was sent to: the one whose stored
   * address is the invited one and is verified. The right address not yet verified is
   * `MailboxUnconfirmed`; a different address or closed offer is `Forbidden`. A used offer is `Conflict`.
   */
  readonly accept: (
    person: Pick<PersonSummary, 'id' | 'name'>,
    id: InvitationId,
  ) => Effect.Effect<MemberChange, CompanyStoreError | MailboxUnconfirmed>
  readonly changeRole: (
    by: PersonId,
    companyId: CompanyId,
    membershipId: MembershipId,
    role: 'admin' | 'member',
  ) => Effect.Effect<Member, CompanyStoreError>
  /** Removes a Member. Used by an admin for someone else and by a Person for themselves. */
  readonly remove: (
    by: PersonId,
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

/**
 * Company and ownership commit with the creator's notice, so no successful creation is invisible.
 * Decode the returned Company before live/changes.ts announce; no caller workspace supplies topics.
 */
const makeCreate = (database: DatabaseService) =>
  Effect.fn('CompanyStore.create')(function* (personId: PersonId, name: string) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const inserted = yield* tx
          .insert(companyTable)
          .values({ id: crypto.randomUUID(), name: name.trim(), slug: slugFor(name) })
          .returning()
        const row = yield* returned(inserted, 'Company')
        const company = yield* decodeCompany({ id: row.id, name: row.name, slug: row.slug })
        yield* tx.insert(membershipTable).values({
          id: crypto.randomUUID(),
          companyId: company.id,
          userId: personId,
          role: 'owner',
        })
        yield* announce(tx, [Topic.person(personId)])
        return company
      }),
    )
  })

/**
 * Hold the Membership's share lock through the session update, preventing removal between the
 * permission read and write. Decode database input here; the caller never supplies stored standing.
 */
const membershipOf = Effect.fn('CompanyStore.membershipOf')(function* (
  tx: Transaction,
  companyId: CompanyId,
  personId: PersonId,
) {
  const rows = yield* tx
    .select()
    .from(membershipTable)
    .where(and(eq(membershipTable.companyId, companyId), eq(membershipTable.userId, personId)))
    .limit(1)
    .for('share')
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

/**
 * Membership authorization and session movement share one transaction. live/changes.ts announce
 * follows the update on its connection, so every committed move wakes this Person's open screens.
 */
const makeEnter = (database: DatabaseService) =>
  Effect.fn('CompanyStore.enter')(function* (
    personId: PersonId,
    sessionId: SessionId,
    companyId: Option.Option<CompanyId>,
  ) {
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        // Missing Membership and missing Company have the same answer; do not confirm its existence.
        if (
          Option.isSome(companyId) &&
          Option.isNone(yield* membershipOf(tx, companyId.value, personId))
        ) {
          return yield* new NotFound({ message: 'Company not found' })
        }
        const owner = yield* moveSession(tx, personId, sessionId, companyId)
        // A missing session changes nothing, so there is nobody to announce a movement for.
        if (Option.isNone(owner)) return undefined
        return yield* announce(tx, [Topic.person(owner.value)])
      }),
    )
  })

/** Project joined columns once before the Member decoder at the database boundary. */
const memberFields = (
  row: typeof membershipTable.$inferSelect,
  person: { readonly name: string; readonly image: string | null; readonly email: string },
) => ({
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
    return yield* Effect.forEach(rows, (row) =>
      decodeMember(memberFields(row.membership, row.person)),
    )
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
  return Invitation.make({
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

/**
 * Replacement, insertion, and audit commit together before live/changes.ts announce. Decision
 * reads use this transaction and its locks; the inserted row supplies the Company audience.
 */
const makeInvite = (database: DatabaseService) =>
  Effect.fn('CompanyStore.invite')(function* (
    inviter: PersonId,
    companyId: CompanyId,
    request: InviteMembershipRequest,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const email = normalized(request.email)
        const existing = yield* tx
          .select({ id: personTable.id })
          .from(personTable)
          .where(eq(personTable.email, email))
          .limit(1)
          .for('share')
        const person = existing[0]
        if (person !== undefined) {
          const personId = yield* decodePersonId(person.id)
          if (Option.isSome(yield* membershipOf(tx, companyId, personId))) {
            return yield* new Conflict({ message: 'That Person is already a Member' })
          }
        }
        const summaries = yield* tx
          .select({ id: personTable.id, name: personTable.name, image: personTable.image })
          .from(personTable)
          .where(eq(personTable.id, inviter))
          .limit(1)
          .for('share')
        const summary = yield* decodeSummary(yield* returned(summaries, 'inviter'))
        const now = yield* Clock.currentTimeMillis
        // Replace the old offer first; the pending unique index refuses an offer if a competing insert wins.
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
        const rows = yield* tx
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
        const stored = yield* storedInvitation(yield* returned(rows, 'invitation'))
        yield* appendAudit(
          tx,
          AuditAttribution.make({
            personId: inviter,
            companyId: stored.companyId,
            by: 'person',
            threadId: null,
          }),
          AuditEvent.cases.MemberInvited.make({ email: stored.email, role: stored.role }),
          now,
        )
        yield* announce(tx, [Topic.company(stored.companyId)])
        return Invitation.make({
          id: stored.id,
          email: stored.email,
          role: stored.role,
          status: standing(stored, now),
          invitedBy: summary,
          expiresAt: stored.expiresAt,
        })
      }),
    )
  })

/**
 * A missing pending offer fails inside the transaction. The changed row owns the audience and
 * live/changes.ts announce is last, preventing a committed revocation without a Company refresh.
 */
const makeRevoke = (database: DatabaseService) =>
  Effect.fn('CompanyStore.revoke')(function* (companyId: CompanyId, id: InvitationId) {
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(invitationTable)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(invitationTable.id, id),
              eq(invitationTable.companyId, companyId),
              eq(invitationTable.status, 'pending'),
            ),
          )
          .returning()
        const row = rows[0]
        if (row === undefined) return yield* new NotFound({ message: 'Invitation not found' })
        const invitation = yield* storedInvitation(row)
        return yield* announce(tx, [Topic.company(invitation.companyId)])
      }),
    )
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
    return yield* new NotFound({ message: 'Invitation not found' })
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

/**
 * Read the Membership with its Person and lock the Membership before deciding or deleting. Its
 * Company, role and Person audience remain authoritative through the write. Lock only Membership
 * to avoid upgrading the mailbox share lock during acceptance. No helper casts a transaction into Database.
 */
const memberById = Effect.fn('CompanyStore.memberById')(function* (
  tx: Transaction,
  companyId: CompanyId,
  membershipId: MembershipId,
) {
  const rows = yield* tx
    .select({ membership: membershipTable, person: personTable })
    .from(membershipTable)
    .innerJoin(personTable, eq(membershipTable.userId, personTable.id))
    .where(and(eq(membershipTable.id, membershipId), eq(membershipTable.companyId, companyId)))
    .limit(1)
    .for('update', { of: membershipTable })
  const row = rows[0]
  if (row === undefined) return yield* new NotFound({ message: 'Member not found' })
  return yield* decodeOwnedMember({
    companyId: row.membership.companyId,
    member: memberFields(row.membership, row.person),
  })
})

/**
 * Read the mailbox under a share lock, never from supplied Person data. Better Auth 1.7.5
 * api/routes/sign-up.mjs signs in an unverified password account immediately; that session proves
 * somebody typed the address, not mailbox ownership. Hold the flag and address through acceptance.
 */
const mailboxOf = Effect.fn('CompanyStore.mailboxOf')(function* (
  tx: Transaction,
  personId: PersonId,
) {
  const rows = yield* tx
    .select({ email: personTable.email, verified: personTable.emailVerified })
    .from(personTable)
    .where(eq(personTable.id, personId))
    .limit(1)
    .for('share')
  const row = rows[0]
  if (row === undefined) return yield* new NotFound({ message: 'Person not found' })
  return yield* decodeMailbox(row)
})

/**
 * Match the current stored mailbox before exposing a claim conflict. An unverified matching
 * account gets its own typed refusal, as Better Auth's organization plugin also requires mailbox
 * verification (plugins/organization/routes/crud-invites.mjs requireEmailVerificationOnInvitation).
 */
const requireMailbox = Effect.fn('CompanyStore.requireMailbox')(function* (
  invitation: StoredInvitation,
  mailbox: typeof StoredMailbox.Type,
  personId: PersonId,
  now: number,
) {
  const status = standing(invitation, now)
  if (
    invitation.email !== normalized(mailbox.email) ||
    status === 'expired' ||
    status === 'revoked'
  ) {
    return yield* new Forbidden({ message: 'This invitation is not open for your account' })
  }
  if (!mailbox.verified)
    return yield* new MailboxUnconfirmed({
      personId,
      invitationId: invitation.id,
      message: 'This email address has not been confirmed as yours',
    })
  return undefined
})

/**
 * Lock the offer, check the current mailbox, claim and insert before auditing. An existing Member
 * fails inside the transaction, keeping the invitation pending. The explicit Person supplies the
 * audit name without inventing an Actor; the locked offer supplies the Company and role. Announce
 * last through live/changes.ts announce so every failure rolls back the claim, Membership and audit.
 */
const makeAccept = (database: DatabaseService) =>
  Effect.fn('CompanyStore.accept')(function* (
    person: Pick<PersonSummary, 'id' | 'name'>,
    id: InvitationId,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(invitationTable)
          .where(eq(invitationTable.id, id))
          .limit(1)
          .for('update')
        const row = rows[0]
        if (row === undefined) return yield* new NotFound({ message: 'Invitation not found' })
        const invitation = yield* storedInvitation(row)
        const mailbox = yield* mailboxOf(tx, person.id)
        const now = yield* Clock.currentTimeMillis
        yield* requireMailbox(invitation, mailbox, person.id, now)
        const claimed = yield* tx
          .update(invitationTable)
          .set({ status: 'accepted' })
          .where(and(eq(invitationTable.id, invitation.id), eq(invitationTable.status, 'pending')))
          .returning({ id: invitationTable.id })
        if (claimed.length === 0)
          return yield* new Conflict({ message: 'This invitation was already used' })
        const inserted = yield* tx
          .insert(membershipTable)
          .values({
            id: crypto.randomUUID(),
            companyId: invitation.companyId,
            userId: person.id,
            role: invitation.role,
          })
          .onConflictDoNothing()
          .returning()
        const membership = inserted[0]
        if (membership === undefined)
          return yield* new Conflict({ message: 'You are already a Member' })
        const stored = yield* decodeStoredMembership({
          id: membership.id,
          companyId: membership.companyId,
          personId: membership.userId,
          role: membership.role,
        })
        const current = yield* memberById(tx, stored.companyId, stored.id)
        yield* appendAudit(
          tx,
          AuditAttribution.make({
            personId: person.id,
            companyId: current.companyId,
            by: 'person',
            threadId: null,
          }),
          AuditEvent.cases.MemberJoined.make({ name: person.name, role: current.member.role }),
          now,
        )
        yield* announce(tx, [
          Topic.company(current.companyId),
          Topic.person(current.member.person.id),
        ])
        return current
      }),
    )
  })

/** The owner's standing is not something an admin can change or remove. */
const refuseOwner = (member: Member) =>
  member.role === 'owner'
    ? Effect.fail(new Forbidden({ message: "A Company's owner cannot be changed here" }))
    : Effect.succeed(member)

/**
 * Read role, Person and audience under the Membership lock before changing it. Audit and
 * live/changes.ts announce join the update so a committed role never leaves either watch stale.
 */
const makeChangeRole = (database: DatabaseService) =>
  Effect.fn('CompanyStore.changeRole')(function* (
    by: PersonId,
    companyId: CompanyId,
    membershipId: MembershipId,
    role: 'admin' | 'member',
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const current = yield* memberById(tx, companyId, membershipId)
        yield* refuseOwner(current.member)
        yield* tx
          .update(membershipTable)
          .set({ role })
          .where(eq(membershipTable.id, current.member.membershipId))
        const member = Member.make({
          membershipId: current.member.membershipId,
          person: current.member.person,
          email: current.member.email,
          role,
          joinedAt: current.member.joinedAt,
        })
        yield* appendAudit(
          tx,
          AuditAttribution.make({
            personId: by,
            companyId: current.companyId,
            by: 'person',
            threadId: null,
          }),
          AuditEvent.cases.RoleChanged.make({ name: member.person.name, role: member.role }),
          yield* Clock.currentTimeMillis,
        )
        yield* announce(tx, [Topic.company(current.companyId), Topic.person(member.person.id)])
        return member
      }),
    )
  })

/**
 * Capture the removed Person and Company under the Membership lock before deleting. Their
 * sessions leave with them, then audit and live/changes.ts announce commit on this connection;
 * the departed Person's topic is necessary to move their open screens back to personal space.
 */
const makeRemove = (database: DatabaseService) =>
  Effect.fn('CompanyStore.remove')(function* (
    by: PersonId,
    companyId: CompanyId,
    membershipId: MembershipId,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const current = yield* memberById(tx, companyId, membershipId)
        const member = yield* refuseOwner(current.member)
        yield* tx.delete(membershipTable).where(eq(membershipTable.id, member.membershipId))
        // What was asked of them in this Company can no longer be theirs to allow.
        yield* invalidatePending(
          tx,
          askedOfMember(member.person.id, current.companyId),
          ApprovalInvalidation.cases.AuthorityChanged.make({ membershipId: member.membershipId }),
        )
        yield* leaveCompanySessions(tx, member.person.id, current.companyId)
        yield* appendAudit(
          tx,
          AuditAttribution.make({
            personId: by,
            companyId: current.companyId,
            by: 'person',
            threadId: null,
          }),
          AuditEvent.cases.MemberRemoved.make({ name: member.person.name }),
          yield* Clock.currentTimeMillis,
        )
        yield* announce(tx, [Topic.company(current.companyId), Topic.person(member.person.id)])
        return member
      }),
    )
  })

/** All appearance columns are replaced together, with decoding before the caller announces. */
const makeSetAppearance = (database: DatabaseService) =>
  Effect.fn('CompanyStore.setAppearance')(function* (companyId: CompanyId, appearance: Appearance) {
    const rows = yield* database.run(
      database
        .update(companyTable)
        .set({
          vividName: appearance.name,
          vividLook: appearance.look,
          vividOutline: appearance.outline,
        })
        .where(eq(companyTable.id, companyId))
        .returning({
          name: companyTable.vividName,
          look: companyTable.vividLook,
          outline: companyTable.vividOutline,
        }),
    )
    return yield* decodeAppearance(yield* returned(rows, 'Appearance'))
  })

export const companyStoreLayer = Layer.effect(
  CompanyStore,
  Effect.gen(function* () {
    const database = yield* Database
    return CompanyStore.of({
      setAppearance: makeSetAppearance(database),
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
