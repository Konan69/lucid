import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  Conflict,
  MeResponse,
  SwitchWorkspaceRequest,
  type AcceptMembershipRequest,
  type ChangeRoleRequest,
  type CompanyId,
  type CreateCompanyRequest,
  type InvitationId,
  type InviteMembershipRequest,
  type MembershipId,
  type PersonName,
  Unauthenticated,
} from '@vivid/contracts'
import {
  findPerson,
  requireActor,
  requireAdmin,
  requireCompany,
  requirePerson,
  type Actor,
} from '../auth/access.ts'
import { sessionWorkspace } from '../auth/session.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { Notifier } from '../notifications/notifier.ts'
import { renamePerson } from '../auth/person.ts'
import { CompanyStore } from './store.ts'

/**
 * The signed-in Person, where they are working, and everywhere else they could be.
 *
 * The Person is read again rather than taken from the Actor. A live query keeps the Person it was
 * opened with (`live/query.ts` reads only the workspace again), so `WatchMe` kept answering with
 * the old name after the Person changed it in Settings; this read is what moves the name on every
 * open screen.
 */
const me = Effect.fn('Companies.me')(function* (actor: Pick<Actor, 'person' | 'workspace'>) {
  const store = yield* CompanyStore
  const person = yield* findPerson(actor.person.id)
  if (Option.isNone(person))
    return yield* new Unauthenticated({ message: 'Person no longer exists' })
  return new MeResponse({
    person: person.value,
    workspace: actor.workspace,
    companies: yield* store.memberships(actor.person.id),
  })
})

/** Everyone in the active Company, and for its admins the invitations still open. */
const people = Effect.fn('Companies.people')(function* (actor: Actor) {
  const { company, role } = yield* requireCompany(actor.workspace)
  const store = yield* CompanyStore
  return {
    members: yield* store.members(company.id),
    // An open invitation shows an address that is not yet a Member's; only the people who can
    // send or revoke one see it.
    invitations: role === 'member' ? [] : yield* store.invitations(company.id),
  }
})

/** `me`, after something moved the session: its workspace is read again rather than assumed. */
const meAfter = Effect.fn('Companies.meAfter')(function* (
  auth: Effect.Success<ReturnType<typeof requirePerson>>,
) {
  const workspace = yield* sessionWorkspace(auth.person.id, auth.sessionId)
  return yield* me({ person: auth.person, workspace })
})

/** The store commits the session movement with its notice before this response reloads it. */
const enter = Effect.fn('Companies.enter')(function* (
  auth: Effect.Success<ReturnType<typeof requirePerson>>,
  companyId: Option.Option<CompanyId>,
) {
  yield* (yield* CompanyStore).enter(auth.person.id, auth.sessionId, companyId)
  return yield* meAfter(auth)
})

export const companyHandlers = {
  Me: Effect.fn('Rpc.Me')(function* () {
    return yield* me(yield* requireActor())
  }),
  WatchMe: () => live('WatchMe', [], me),
  /** Only the Person names themselves; Vivid reads the name and never changes it. */
  SetPersonName: Effect.fn('Rpc.SetPersonName')(function* ({
    name,
  }: {
    readonly name: PersonName
  }) {
    const auth = yield* requirePerson()
    yield* renamePerson(auth.person.id, name)
    // The Person's own topic reopens `WatchMe` on every device; a Company's moves its People list.
    yield* changed(auth)
    return yield* meAfter(auth)
  }),
  /**
   * A Company exists because a Person asked for one by name. Nothing else in the product creates
   * one: not signing up, not inviting someone, not sharing a Thread.
   */
  CreateCompany: Effect.fn('Rpc.CreateCompany')(function* (request: CreateCompanyRequest) {
    const auth = yield* requirePerson()
    const company = yield* (yield* CompanyStore).create(auth.person.id, request.name)
    yield* enter(auth, Option.some(company.id))
    return company
  }),
  SwitchWorkspace: Effect.fn('Rpc.SwitchWorkspace')(function* ({
    to,
  }: {
    readonly to: SwitchWorkspaceRequest
  }) {
    const auth = yield* requirePerson()
    return yield* enter(
      auth,
      SwitchWorkspaceRequest.match(to, {
        Personal: () => Option.none<CompanyId>(),
        Company: ({ companyId }) => Option.some(companyId),
      }),
    )
  }),
  ListPeople: Effect.fn('Rpc.ListPeople')(function* () {
    return yield* people(yield* requireActor())
  }),
  WatchPeople: () => live('WatchPeople', [], people),
  /** The store commits its audit and notice before the external invitation notification. */
  InviteMember: Effect.fn('Rpc.InviteMember')(function* (request: InviteMembershipRequest) {
    const auth = yield* requirePerson()
    const { company } = yield* requireAdmin(auth.workspace)
    const store = yield* CompanyStore
    const invitation = yield* store.invite(auth.person.id, company.id, request)
    // Someone who already has an account is told where they will see it: in their own space.
    const invited = yield* store.personByEmail(invitation.email)
    if (Option.isSome(invited)) {
      yield* (yield* Notifier).notify({
        personId: invited.value,
        companyId: null,
        kind: 'invited',
        title: `Join ${company.name}`,
        body: `${auth.person.name} invited you to ${company.name}. invitation:${invitation.id}`,
        threadId: null,
      })
    }
    return invitation
  }),
  /** The store owns revocation and its Company notice as one transaction. */
  RevokeInvitation: Effect.fn('Rpc.RevokeInvitation')(function* ({
    id,
  }: {
    readonly id: InvitationId
  }) {
    const auth = yield* requirePerson()
    const { company } = yield* requireAdmin(auth.workspace)
    yield* (yield* CompanyStore).revoke(company.id, id)
  }),
  PreviewInvitation: Effect.fn('Rpc.PreviewInvitation')(function* ({
    id,
  }: {
    readonly id: InvitationId
  }) {
    yield* requirePerson()
    return yield* (yield* CompanyStore).preview(id)
  }),
  /** Join commits with audit and notice before a separate transaction moves the session. */
  AcceptInvitation: Effect.fn('Rpc.AcceptInvitation')(function* (request: AcceptMembershipRequest) {
    const auth = yield* requirePerson()
    const store = yield* CompanyStore
    const joined = yield* store.accept(auth.person, request.invitationId)
    return yield* enter(auth, Option.some(joined.companyId))
  }),
  /** Authorize here; the store locks and reads the Member audience before changing it. */
  ChangeRole: Effect.fn('Rpc.ChangeRole')(function* (request: ChangeRoleRequest) {
    const auth = yield* requirePerson()
    const { company } = yield* requireAdmin(auth.workspace)
    return yield* (yield* CompanyStore).changeRole(
      auth.person.id,
      company.id,
      request.membershipId,
      request.role,
    )
  }),
  /** Authorize here; the store captures the removed Person under lock before deleting. */
  RemoveMember: Effect.fn('Rpc.RemoveMember')(function* ({
    membershipId,
  }: {
    readonly membershipId: MembershipId
  }) {
    const auth = yield* requirePerson()
    const { company } = yield* requireAdmin(auth.workspace)
    yield* (yield* CompanyStore).remove(auth.person.id, company.id, membershipId)
  }),
  /** The store rechecks the selected Membership under lock and announces the departing Person. */
  LeaveCompany: Effect.fn('Rpc.LeaveCompany')(function* () {
    const auth = yield* requirePerson()
    const { company } = yield* requireCompany(auth.workspace)
    const store = yield* CompanyStore
    const members = yield* store.members(company.id)
    const mine = members.find((member) => member.person.id === auth.person.id)
    if (mine === undefined) {
      return yield* new Conflict({ message: 'You are not a Member of this Company' })
    }
    yield* store.remove(auth.person.id, company.id, mine.membershipId)
    return yield* meAfter(auth)
  }),
}
