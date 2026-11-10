import { Schema } from 'effect'
import { CompanyId, InvitationId, MembershipId, Person, PersonSummary } from './identity.js'

/**
 * What a Membership permits. An owner created the Company and can remove it; an admin manages
 * people, Company rules and shared Connections; a member works inside what those two set up.
 * No role grants reading a Thread its holder is not in.
 */
export const Role = Schema.Literals(['owner', 'admin', 'member'] as const)
export type Role = typeof Role.Type

export class Company extends Schema.Class<Company>('Company')(
  {
    id: CompanyId,
    name: Schema.String,
    slug: Schema.String,
  },
  { title: 'Company' },
) {}

/**
 * Where a Person is working. A Person starts in their personal space, which belongs to them alone
 * and has no Company. A Company exists only because someone created it on purpose; inside one, the
 * Company's shared Connections, rules, Library and memory apply as well as the Person's own.
 */
export const Workspace = Schema.TaggedUnion({
  Personal: {},
  Company: { company: Company, role: Role },
})
export type Workspace = typeof Workspace.Type

/** A Company the signed-in Person belongs to, with the role they hold there. */
export const CompanyMembership = Schema.Struct({
  company: Company,
  role: Role,
}).annotate({ identifier: 'CompanyMembership', title: 'Company membership' })
export interface CompanyMembership extends Schema.Schema.Type<typeof CompanyMembership> {}

/** Creating a Company is always a deliberate act: the Person names it. The slug is derived. */
export class CreateCompanyRequest extends Schema.Class<CreateCompanyRequest>(
  'CreateCompanyRequest',
)(
  {
    name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  },
  { title: 'Create Company request' },
) {}

/** Which workspace the session should work in from now on. */
export const SwitchWorkspaceRequest = Schema.TaggedUnion({
  Personal: {},
  Company: { companyId: CompanyId },
})
export type SwitchWorkspaceRequest = typeof SwitchWorkspaceRequest.Type

export class InviteMembershipRequest extends Schema.Class<InviteMembershipRequest>(
  'InviteMembershipRequest',
)(
  {
    email: Schema.String,
    role: Schema.Literals(['admin', 'member'] as const),
  },
  { title: 'Invite Membership request' },
) {}

export class AcceptMembershipRequest extends Schema.Class<AcceptMembershipRequest>(
  'AcceptMembershipRequest',
)(
  {
    invitationId: InvitationId,
  },
  { title: 'Accept Membership request' },
) {}

export class MeResponse extends Schema.Class<MeResponse>('MeResponse')(
  {
    person: Person,
    workspace: Workspace,
    /** Every Company this Person belongs to, so the client can offer a switch without asking. */
    companies: Schema.Array(CompanyMembership),
  },
  { title: 'Current Person response' },
) {}

/** Where an invitation stands. Only a pending one can be accepted or revoked. */
export const InvitationStatus = Schema.Literals([
  'pending',
  'accepted',
  'revoked',
  'expired',
] as const)
export type InvitationStatus = typeof InvitationStatus.Type

/** One Person in a Company, as the People screen shows them. The email is visible to Members. */
export const Member = Schema.Struct({
  membershipId: MembershipId,
  person: PersonSummary,
  email: Schema.String,
  role: Role,
  joinedAt: Schema.Finite,
}).annotate({ identifier: 'Member', title: 'Member' })
export interface Member extends Schema.Schema.Type<typeof Member> {}

/** A pending offer of Membership, with what the People screen needs to show and revoke it. */
export const Invitation = Schema.Struct({
  id: InvitationId,
  email: Schema.String,
  role: Role,
  status: InvitationStatus,
  invitedBy: PersonSummary,
  expiresAt: Schema.Finite,
}).annotate({ identifier: 'Invitation', title: 'Invitation' })
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}

/** Everyone in the active Company and every invitation still open. */
export const PeopleResponse = Schema.Struct({
  members: Schema.Array(Member),
  invitations: Schema.Array(Invitation),
}).annotate({ identifier: 'PeopleResponse', title: 'People response' })
export interface PeopleResponse extends Schema.Schema.Type<typeof PeopleResponse> {}

/** What an invited Person sees before accepting: who invited them, and to which Company. */
export const InvitationPreview = Schema.Struct({
  id: InvitationId,
  company: Company,
  role: Role,
  invitedBy: PersonSummary,
  status: InvitationStatus,
}).annotate({ identifier: 'InvitationPreview', title: 'Invitation preview' })
export interface InvitationPreview extends Schema.Schema.Type<typeof InvitationPreview> {}

/** A Member's role changes only between admin and member; ownership is not handed over here. */
export const ChangeRoleRequest = Schema.Struct({
  membershipId: MembershipId,
  role: Schema.Literals(['admin', 'member'] as const),
})
export interface ChangeRoleRequest extends Schema.Schema.Type<typeof ChangeRoleRequest> {}
