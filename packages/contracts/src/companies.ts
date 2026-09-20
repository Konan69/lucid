import { Schema } from 'effect'
import { CompanyId, MembershipId, Person, PersonId } from './identity.js'

export class Company extends Schema.Class<Company>('Company')(
  {
    id: CompanyId,
    name: Schema.String,
    slug: Schema.String,
  },
  { title: 'Company' },
) {}

export class Membership extends Schema.Class<Membership>('Membership')(
  {
    id: MembershipId,
    companyId: CompanyId,
    personId: PersonId,
    role: Schema.String,
  },
  { title: 'Membership' },
) {}

export class CreateCompanyRequest extends Schema.Class<CreateCompanyRequest>(
  'CreateCompanyRequest',
)(
  {
    name: Schema.String,
    slug: Schema.String,
  },
  { title: 'Create Company request' },
) {}

export class InviteMembershipRequest extends Schema.Class<InviteMembershipRequest>(
  'InviteMembershipRequest',
)(
  {
    email: Schema.String,
    role: Schema.String,
  },
  { title: 'Invite Membership request' },
) {}

export class AcceptMembershipRequest extends Schema.Class<AcceptMembershipRequest>(
  'AcceptMembershipRequest',
)(
  {
    invitationId: Schema.String,
  },
  { title: 'Accept Membership request' },
) {}

export class MeResponse extends Schema.Class<MeResponse>('MeResponse')(
  {
    person: Person,
    activeCompany: Schema.optional(Company),
    membership: Schema.optional(Membership),
  },
  { title: 'Current Person response' },
) {}

export class CompanyListResponse extends Schema.Class<CompanyListResponse>('CompanyListResponse')(
  {
    companies: Schema.Array(Company),
  },
  { title: 'Company list response' },
) {}

export class InvitationResponse extends Schema.Class<InvitationResponse>('InvitationResponse')(
  {
    id: Schema.String,
    companyId: CompanyId,
    email: Schema.String,
    role: Schema.String,
    status: Schema.String,
  },
  { title: 'Invitation response' },
) {}
