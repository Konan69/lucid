import * as Effect from 'effect/Effect'
import {
  CompanyListResponse,
  MeResponse,
  type AcceptMembershipRequest,
  type CreateCompanyRequest,
  type InviteMembershipRequest,
} from '@vivid/contracts'
import { requireActiveCompany, requirePerson } from '../auth/session.ts'
import { CompanyStore } from './store.ts'

export const me = Effect.fn('Api.me')(function* () {
  const auth = yield* requirePerson()
  return new MeResponse({
    person: auth.person,
    ...(auth.activeCompany === undefined ? {} : { activeCompany: auth.activeCompany }),
    ...(auth.membership === undefined ? {} : { membership: auth.membership }),
  })
})
export const listCompanies = Effect.fn('Api.listCompanies')(function* () {
  const auth = yield* requirePerson()
  const store = yield* CompanyStore
  return new CompanyListResponse({ companies: yield* store.list(auth.person.id) })
})
export const createCompany = Effect.fn('Api.createCompany')(function* (
  payload: CreateCompanyRequest,
) {
  const auth = yield* requirePerson()
  const store = yield* CompanyStore
  return yield* store.create(auth.person.id, auth.sessionId, payload)
})
export const inviteMembership = Effect.fn('Api.inviteMembership')(function* (
  payload: InviteMembershipRequest,
) {
  const { auth, company, membership } = yield* requireActiveCompany()
  const store = yield* CompanyStore
  return yield* store.invite(auth.person.id, company.id, membership.role, payload)
})
export const acceptMembership = Effect.fn('Api.acceptMembership')(function* (
  payload: AcceptMembershipRequest,
) {
  const auth = yield* requirePerson()
  const store = yield* CompanyStore
  return yield* store.accept(
    auth.person.id,
    auth.person.email,
    auth.sessionId,
    payload.invitationId,
  )
})
