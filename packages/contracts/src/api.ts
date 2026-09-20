import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/unstable/httpapi/HttpApiMiddleware'
import * as HttpApiSchema from 'effect/unstable/httpapi/HttpApiSchema'
import {
  AcceptMembershipRequest,
  Company,
  CompanyListResponse,
  Conflict,
  CreateCompanyRequest,
  CreateProjectRequest,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvitationResponse,
  InviteMembershipRequest,
  Membership,
  MeResponse,
  NotFound,
  PatchSettingsRequest,
  Person,
  Project,
  ProjectListResponse,
  Settings,
  SessionId,
  Unauthenticated,
} from './index.js'

/**
 * The application server's HTTP API, declared once. The server implements it with
 * `HttpApiBuilder`; every client derives its requests, responses and failures from it with
 * `HttpApiClient.make(VividApi)`. Nothing here may import server code: a client bundle imports
 * this module. Pattern after `ai-docs/src/51_http-server` in the pinned Effect source.
 */

export type AuthState = Data.TaggedEnum<{
  Person: {
    readonly person: Person
    readonly activeCompany?: Company
    readonly membership?: Membership
    readonly sessionId: SessionId
  }
  Runtime: {}
}>

export const AuthState = Data.taggedEnum<AuthState>()
export class AuthContext extends Context.Service<AuthContext, AuthState>()('vivid/AuthContext') {}

export const apiErrors = [
  Unauthenticated.pipe(HttpApiSchema.status(401)),
  Forbidden.pipe(HttpApiSchema.status(403)),
  NotFound.pipe(HttpApiSchema.status(404)),
  Conflict.pipe(HttpApiSchema.status(409)),
  DatabaseConstraintViolation.pipe(HttpApiSchema.status(409)),
  DatabaseUnavailable.pipe(HttpApiSchema.status(503)),
  DatabaseFailure.pipe(HttpApiSchema.status(500)),
] as const

/**
 * `requires` names other middleware only. What the server's implementation needs (its database,
 * its configuration) belongs to that implementation's Layer, so it never reaches a client.
 */
export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: AuthContext; requires: never }
>()('vivid/AuthMiddleware', { error: apiErrors }) {}

const me = HttpApiEndpoint.get('me', '/me', { success: MeResponse, error: apiErrors })
const listCompanies = HttpApiEndpoint.get('listCompanies', '/companies', {
  success: CompanyListResponse,
  error: apiErrors,
})
const createCompany = HttpApiEndpoint.post('createCompany', '/companies', {
  payload: CreateCompanyRequest,
  success: Company.pipe(HttpApiSchema.status(201)),
  error: apiErrors,
})
const listProjects = HttpApiEndpoint.get('listProjects', '/projects', {
  success: ProjectListResponse,
  error: apiErrors,
})
const createProject = HttpApiEndpoint.post('createProject', '/projects', {
  payload: CreateProjectRequest,
  success: Project.pipe(HttpApiSchema.status(201)),
  error: apiErrors,
})
const inviteMembership = HttpApiEndpoint.post('inviteMembership', '/memberships/invite', {
  payload: InviteMembershipRequest,
  success: InvitationResponse.pipe(HttpApiSchema.status(201)),
  error: apiErrors,
})
const acceptMembership = HttpApiEndpoint.post('acceptMembership', '/memberships/accept', {
  payload: AcceptMembershipRequest,
  success: Membership,
  error: apiErrors,
})
const getSettings = HttpApiEndpoint.get('getSettings', '/settings', {
  success: Settings,
  error: apiErrors,
})
const patchSettings = HttpApiEndpoint.patch('patchSettings', '/settings', {
  payload: PatchSettingsRequest,
  success: Settings,
  error: apiErrors,
})

const ApiGroup = HttpApiGroup.make('vivid')
  .add(
    me,
    listCompanies,
    createCompany,
    listProjects,
    createProject,
    inviteMembership,
    acceptMembership,
    getSettings,
    patchSettings,
  )
  .middleware(AuthMiddleware)

export const VividApi = HttpApi.make('VividApi').add(ApiGroup).prefix('/api')
