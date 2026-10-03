import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  AuditEvent,
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
} from '@vivid/contracts'
import { Audit } from '../audit/record.ts'
import {
  requireActor,
  requireAdmin,
  requireCompany,
  requirePerson,
  type Actor,
} from '../auth/access.ts'
import { sessionWorkspace } from '../auth/session.ts'
import { Changes, Topic, topicsOf } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { Notifier } from '../notifications/notifier.ts'
import { CompanyStore } from './store.ts'

/** The signed-in Person, where they are working, and everywhere else they could be. */
const me = Effect.fn('Companies.me')(function* (actor: Pick<Actor, 'person' | 'workspace'>) {
  const store = yield* CompanyStore
  return new MeResponse({
    person: actor.person,
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

/** Moves the session and tells every open screen of this Person to follow it. */
const enter = Effect.fn('Companies.enter')(function* (
  auth: Effect.Success<ReturnType<typeof requirePerson>>,
  companyId: Option.Option<CompanyId>,
) {
  yield* (yield* CompanyStore).enter(auth.person.id, auth.sessionId, companyId)
  yield* (yield* Changes).publish([Topic.person(auth.person.id)])
  return yield* meAfter(auth)
})

export const companyHandlers = {
  Me: Effect.fn('Rpc.Me')(function* () {
    return yield* me(yield* requireActor())
  }),
  WatchMe: () => live(me),
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
  WatchPeople: () => live(people),
  InviteMember: Effect.fn('Rpc.InviteMember')(function* (request: InviteMembershipRequest) {
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const { company } = yield* requireAdmin(auth.workspace)
    const store = yield* CompanyStore
    const invitation = yield* store.invite(auth.person.id, company.id, request)
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.MemberInvited.make({ email: invitation.email, role: invitation.role }),
    )
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
    yield* (yield* Changes).publish(topicsOf(auth))
    return invitation
  }),
  RevokeInvitation: Effect.fn('Rpc.RevokeInvitation')(function* ({
    id,
  }: {
    readonly id: InvitationId
  }) {
    const auth = yield* requirePerson()
    const { company } = yield* requireAdmin(auth.workspace)
    yield* (yield* CompanyStore).revoke(company.id, id)
    yield* (yield* Changes).publish(topicsOf(auth))
  }),
  PreviewInvitation: Effect.fn('Rpc.PreviewInvitation')(function* ({
    id,
  }: {
    readonly id: InvitationId
  }) {
    yield* requirePerson()
    return yield* (yield* CompanyStore).preview(id)
  }),
  AcceptInvitation: Effect.fn('Rpc.AcceptInvitation')(function* (request: AcceptMembershipRequest) {
    const auth = yield* requirePerson()
    const store = yield* CompanyStore
    const joined = yield* store.accept(auth.person, request.invitationId)
    const response = yield* enter(auth, Option.some(joined.companyId))
    const actor = yield* requireActor()
    yield* (yield* Audit).record(
      { ...actor, workspace: response.workspace },
      AuditEvent.cases.MemberJoined.make({
        name: auth.person.name,
        role: joined.member.role,
      }),
    )
    yield* (yield* Changes).publish([Topic.company(joined.companyId)])
    return response
  }),
  ChangeRole: Effect.fn('Rpc.ChangeRole')(function* (request: ChangeRoleRequest) {
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const { company } = yield* requireAdmin(auth.workspace)
    const member = yield* (yield* CompanyStore).changeRole(
      company.id,
      request.membershipId,
      request.role,
    )
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.RoleChanged.make({ name: member.person.name, role: member.role }),
    )
    yield* (yield* Changes).publish([...topicsOf(auth), Topic.person(member.person.id)])
    return member
  }),
  RemoveMember: Effect.fn('Rpc.RemoveMember')(function* ({
    membershipId,
  }: {
    readonly membershipId: MembershipId
  }) {
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const { company } = yield* requireAdmin(auth.workspace)
    const member = yield* (yield* CompanyStore).remove(company.id, membershipId)
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.MemberRemoved.make({ name: member.person.name }),
    )
    // Their own topic is what moves their open screens back to their personal space.
    yield* (yield* Changes).publish([...topicsOf(auth), Topic.person(member.person.id)])
  }),
  LeaveCompany: Effect.fn('Rpc.LeaveCompany')(function* () {
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const { company } = yield* requireCompany(auth.workspace)
    const store = yield* CompanyStore
    const members = yield* store.members(company.id)
    const mine = members.find((member) => member.person.id === auth.person.id)
    if (mine === undefined) {
      return yield* Effect.fail(new Conflict({ message: 'You are not a Member of this Company' }))
    }
    yield* store.remove(company.id, mine.membershipId)
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.MemberRemoved.make({ name: auth.person.name }),
    )
    yield* (yield* Changes).publish([Topic.company(company.id), Topic.person(auth.person.id)])
    return yield* meAfter(auth)
  }),
}
