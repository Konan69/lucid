import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/unstable/httpapi/HttpApiMiddleware'
import * as HttpApiSchema from 'effect/unstable/httpapi/HttpApiSchema'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import { and, desc, eq } from 'drizzle-orm'
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
  Unauthenticated,
} from '@vivid/contracts'
import { Database } from './database.ts'
import { ServerConfig } from './config.ts'
import { authEffect, localAuthRuntimeLayer } from './auth.ts'
import {
  companyTable,
  invitationTable,
  membershipTable,
  personTable,
  projectTable,
  sessionTable,
  settingsTable,
} from './schema.ts'

export interface AuthState {
  readonly person: Person
  readonly activeCompany?: Company
  readonly membership?: Membership
  readonly sessionId: string
}

export class AuthContext extends Context.Service<AuthContext, AuthState>()('vivid/AuthContext') {}

const errors = [
  Unauthenticated.pipe(HttpApiSchema.status(401)),
  Forbidden.pipe(HttpApiSchema.status(403)),
  NotFound.pipe(HttpApiSchema.status(404)),
  Conflict.pipe(HttpApiSchema.status(409)),
  DatabaseConstraintViolation.pipe(HttpApiSchema.status(409)),
  DatabaseUnavailable.pipe(HttpApiSchema.status(503)),
  DatabaseFailure.pipe(HttpApiSchema.status(500)),
] as const

export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: AuthContext; requires: Database | ServerConfig }
>()('vivid/AuthMiddleware', { error: errors }) {}

const me = HttpApiEndpoint.get('me', '/me', { success: MeResponse, error: errors })
const listCompanies = HttpApiEndpoint.get('listCompanies', '/companies', {
  success: CompanyListResponse,
  error: errors,
})
const createCompany = HttpApiEndpoint.post('createCompany', '/companies', {
  payload: CreateCompanyRequest,
  success: Company.pipe(HttpApiSchema.status(201)),
  error: errors,
})
const listProjects = HttpApiEndpoint.get('listProjects', '/projects', {
  success: ProjectListResponse,
  error: errors,
})
const createProject = HttpApiEndpoint.post('createProject', '/projects', {
  payload: CreateProjectRequest,
  success: Project.pipe(HttpApiSchema.status(201)),
  error: errors,
})
const inviteMembership = HttpApiEndpoint.post('inviteMembership', '/memberships/invite', {
  payload: InviteMembershipRequest,
  success: InvitationResponse.pipe(HttpApiSchema.status(201)),
  error: errors,
})
const acceptMembership = HttpApiEndpoint.post('acceptMembership', '/memberships/accept', {
  payload: AcceptMembershipRequest,
  success: Membership,
  error: errors,
})
const getSettings = HttpApiEndpoint.get('getSettings', '/settings', {
  success: Settings,
  error: errors,
})
const patchSettings = HttpApiEndpoint.patch('patchSettings', '/settings', {
  payload: PatchSettingsRequest,
  success: Settings,
  error: errors,
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

export const api = HttpApi.make('VividApi').add(ApiGroup).prefix('/api')

const decodePersistence = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  value: Readonly<Record<string, string | number | boolean | null>>,
): Effect.Effect<Value, DatabaseFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new DatabaseFailure({ message: 'Database returned invalid application data' }),
    ),
  )

const fromPerson = Effect.fn('Persistence.fromPerson')((row: typeof personTable.$inferSelect) =>
  decodePersistence(Person, {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  }),
)

const fromCompany = Effect.fn('Persistence.fromCompany')((row: typeof companyTable.$inferSelect) =>
  decodePersistence(Company, {
    id: row.id,
    name: row.name,
    slug: row.slug,
  }),
)

const fromMembership = Effect.fn('Persistence.fromMembership')(
  (row: typeof membershipTable.$inferSelect) =>
    decodePersistence(Membership, {
      id: row.id,
      companyId: row.companyId,
      personId: row.userId,
      role: row.role,
    }),
)

const fromProject = Effect.fn('Persistence.fromProject')(function* (
  row: typeof projectTable.$inferSelect,
): Effect.fn.Return<Project, DatabaseFailure> {
  const project = {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    createdBy: row.createdBy,
  }
  return yield* row.parentProjectId === null
    ? decodePersistence(Project, project)
    : decodePersistence(Project, { ...project, parentProjectId: row.parentProjectId })
})

interface ActiveCompanyAuth {
  readonly auth: AuthState
  readonly company: Company
  readonly membership: Membership
}

const requireActiveCompany = Effect.fn('Auth.requireActiveCompany')(function* (): Effect.fn.Return<
  ActiveCompanyAuth,
  Forbidden,
  AuthContext
> {
  const auth = yield* AuthContext
  if (auth.activeCompany === undefined || auth.membership === undefined) {
    return yield* Effect.fail(new Forbidden({ message: 'An active Company is required' }))
  }
  return { auth, company: auth.activeCompany, membership: auth.membership }
})

export const authenticate = Effect.fn('Auth.authenticate')(function* (headers: Headers) {
  const auth = yield* authEffect
  const session = yield* auth.getSession(headers).pipe(
    Effect.provide(localAuthRuntimeLayer),
    Effect.mapError(() => new Unauthenticated({ message: 'Invalid session' })),
  )
  if (session === null) {
    return yield* Effect.fail(new Unauthenticated({ message: 'Authentication required' }))
  }
  const db = yield* Database
  const users = yield* db.run(
    db.select().from(personTable).where(eq(personTable.id, session.user.id)).limit(1),
  )
  const personRow = users[0]
  if (personRow === undefined) {
    return yield* Effect.fail(new Unauthenticated({ message: 'Person no longer exists' }))
  }
  const sessionRows = yield* db.run(
    db
      .select({ activeCompanyId: sessionTable.activeCompanyId })
      .from(sessionTable)
      .where(eq(sessionTable.id, session.session.id))
      .limit(1),
  )
  const person = yield* fromPerson(personRow)
  const baseState: AuthState = { person, sessionId: session.session.id }
  const sessionRow = sessionRows[0]
  if (sessionRow === undefined || sessionRow.activeCompanyId === null) return baseState
  const rows = yield* db.run(
    db
      .select({ company: companyTable, membership: membershipTable })
      .from(membershipTable)
      .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
      .where(
        and(
          eq(membershipTable.companyId, sessionRow.activeCompanyId),
          eq(membershipTable.userId, personRow.id),
        ),
      )
      .limit(1),
  )
  const active = rows[0]
  if (active === undefined) return baseState
  const [activeCompany, membership] = yield* Effect.all([
    fromCompany(active.company),
    fromMembership(active.membership),
  ])
  return { ...baseState, activeCompany, membership }
})

export const authMiddlewareLayer = Layer.succeed(AuthMiddleware, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = new globalThis.Headers(Object.entries(request.headers))
    const auth = yield* authenticate(headers)
    return yield* Effect.provideService(httpEffect, AuthContext, auth)
  }),
)

/** Returns the authenticated Person and any active Company context. */
const handleMe = Effect.fn('Api.me')(function* () {
  const auth = yield* AuthContext
  if (auth.activeCompany === undefined && auth.membership === undefined) {
    return new MeResponse({ person: auth.person })
  }
  if (auth.activeCompany === undefined) {
    return new MeResponse({ person: auth.person, membership: auth.membership })
  }
  if (auth.membership === undefined) {
    return new MeResponse({ person: auth.person, activeCompany: auth.activeCompany })
  }
  return new MeResponse({
    person: auth.person,
    activeCompany: auth.activeCompany,
    membership: auth.membership,
  })
})

/** Lists the Companies reachable through the current Person's memberships. */
const handleListCompanies = Effect.fn('Api.listCompanies')(function* () {
  const auth = yield* AuthContext
  const db = yield* Database
  const rows = yield* db.run(
    db
      .select({ company: companyTable })
      .from(membershipTable)
      .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
      .where(eq(membershipTable.userId, auth.person.id))
      .orderBy(desc(companyTable.createdAt)),
  )
  const companies = yield* Effect.forEach(rows, (row) => fromCompany(row.company))
  return new CompanyListResponse({ companies })
})

/** Creates one Company, owner Membership, and active-session selection atomically. */
const handleCreateCompany = Effect.fn('Api.createCompany')(function* (
  payload: typeof CreateCompanyRequest.Type,
) {
  const auth = yield* AuthContext
  const db = yield* Database
  const existing = yield* db.run(
    db.select().from(companyTable).where(eq(companyTable.slug, payload.slug)).limit(1),
  )
  if (existing.length > 0) {
    return yield* Effect.fail(new Conflict({ message: 'Company slug is already in use' }))
  }
  const companyId = crypto.randomUUID()
  const companyRows = yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const inserted = yield* tx
        .insert(companyTable)
        .values({ id: companyId, name: payload.name, slug: payload.slug })
        .returning()
      yield* tx
        .insert(membershipTable)
        .values({ id: crypto.randomUUID(), companyId, userId: auth.person.id, role: 'owner' })
      yield* tx
        .update(sessionTable)
        .set({ activeCompanyId: companyId })
        .where(eq(sessionTable.id, auth.sessionId))
      return inserted
    }),
  )
  const company = companyRows[0]
  if (company === undefined) {
    return yield* Effect.fail(new Conflict({ message: 'Company could not be created' }))
  }
  return yield* fromCompany(company)
})

/** Lists Projects belonging to the active Company. */
const handleListProjects = Effect.fn('Api.listProjects')(function* () {
  const { company } = yield* requireActiveCompany()
  const db = yield* Database
  const rows = yield* db.run(
    db
      .select()
      .from(projectTable)
      .where(eq(projectTable.companyId, company.id))
      .orderBy(desc(projectTable.createdAt)),
  )
  const projects = yield* Effect.forEach(rows, fromProject)
  return new ProjectListResponse({ projects })
})

/** Creates a Project after checking that its optional parent shares the active Company. */
const handleCreateProject = Effect.fn('Api.createProject')(function* (
  payload: typeof CreateProjectRequest.Type,
) {
  const { auth, company } = yield* requireActiveCompany()
  const db = yield* Database
  if (payload.parentProjectId !== undefined) {
    const parent = yield* db.run(
      db
        .select()
        .from(projectTable)
        .where(
          and(eq(projectTable.id, payload.parentProjectId), eq(projectTable.companyId, company.id)),
        )
        .limit(1),
    )
    if (parent.length === 0) {
      return yield* Effect.fail(new NotFound({ message: 'Parent Project not found' }))
    }
  }
  const rows = yield* db.run(
    db
      .insert(projectTable)
      .values({
        id: crypto.randomUUID(),
        companyId: company.id,
        name: payload.name,
        parentProjectId: payload.parentProjectId,
        createdBy: auth.person.id,
      })
      .returning(),
  )
  const project = rows[0]
  if (project === undefined) {
    return yield* Effect.fail(new Conflict({ message: 'Project could not be created' }))
  }
  return yield* fromProject(project)
})

/** Creates a pending Company invitation when the Membership can administer it. */
const handleInviteMembership = Effect.fn('Api.inviteMembership')(function* (
  payload: typeof InviteMembershipRequest.Type,
) {
  const { auth, company, membership } = yield* requireActiveCompany()
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return yield* Effect.fail(new Forbidden({ message: 'Only Company administrators can invite' }))
  }
  const db = yield* Database
  const rows = yield* db.run(
    db
      .insert(invitationTable)
      .values({
        id: crypto.randomUUID(),
        companyId: company.id,
        email: payload.email,
        role: payload.role,
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        inviterId: auth.person.id,
      })
      .returning(),
  )
  const invitation = rows[0]
  if (invitation === undefined) {
    return yield* Effect.fail(new Conflict({ message: 'Invitation could not be created' }))
  }
  return yield* decodePersistence(InvitationResponse, {
    id: invitation.id,
    companyId: company.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
  })
})

/** Accepts one valid invitation and activates its Company in the current session. */
const handleAcceptMembership = Effect.fn('Api.acceptMembership')(function* (
  payload: typeof AcceptMembershipRequest.Type,
) {
  const auth = yield* AuthContext
  const db = yield* Database
  const rows = yield* db.run(
    db.select().from(invitationTable).where(eq(invitationTable.id, payload.invitationId)).limit(1),
  )
  const invitation = rows[0]
  if (invitation === undefined) {
    return yield* Effect.fail(new NotFound({ message: 'Invitation not found' }))
  }
  if (
    invitation.status !== 'pending' ||
    invitation.expiresAt < new Date() ||
    invitation.email.toLowerCase() !== auth.person.email.toLowerCase()
  ) {
    return yield* Effect.fail(new Forbidden({ message: 'Invitation is not valid for this Person' }))
  }
  const already = yield* db.run(
    db
      .select()
      .from(membershipTable)
      .where(
        and(
          eq(membershipTable.companyId, invitation.companyId),
          eq(membershipTable.userId, auth.person.id),
        ),
      )
      .limit(1),
  )
  if (already.length > 0) {
    return yield* Effect.fail(new Conflict({ message: 'Person is already a Member' }))
  }
  const result = yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const inserted = yield* tx
        .insert(membershipTable)
        .values({
          id: crypto.randomUUID(),
          companyId: invitation.companyId,
          userId: auth.person.id,
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
        .where(eq(sessionTable.id, auth.sessionId))
      return inserted
    }),
  )
  const member = result[0]
  if (member === undefined) {
    return yield* Effect.fail(new Conflict({ message: 'Membership could not be created' }))
  }
  return yield* fromMembership(member)
})

/** Reads settings or creates their initial system-theme row. */
const handleGetSettings = Effect.fn('Api.getSettings')(function* () {
  const auth = yield* AuthContext
  const db = yield* Database
  const rows = yield* db.run(
    db.select().from(settingsTable).where(eq(settingsTable.personId, auth.person.id)).limit(1),
  )
  const row = rows[0]
  if (row !== undefined) {
    return yield* decodePersistence(Settings, { personId: auth.person.id, theme: row.theme })
  }
  yield* db.run(db.insert(settingsTable).values({ personId: auth.person.id, theme: 'system' }))
  return yield* decodePersistence(Settings, { personId: auth.person.id, theme: 'system' })
})

/** Upserts the current Person's settings after deriving omitted fields from persistence. */
const handlePatchSettings = Effect.fn('Api.patchSettings')(function* (
  payload: typeof PatchSettingsRequest.Type,
) {
  const auth = yield* AuthContext
  const db = yield* Database
  const current = yield* db.run(
    db.select().from(settingsTable).where(eq(settingsTable.personId, auth.person.id)).limit(1),
  )
  const currentRow = current[0]
  const theme = payload.theme ?? (currentRow === undefined ? 'system' : currentRow.theme)
  const rows = yield* db.run(
    db
      .insert(settingsTable)
      .values({ personId: auth.person.id, theme })
      .onConflictDoUpdate({
        target: settingsTable.personId,
        set: { theme, updatedAt: new Date() },
      })
      .returning(),
  )
  const row = rows[0]
  if (row === undefined) {
    return yield* Effect.fail(new Conflict({ message: 'Settings could not be saved' }))
  }
  return yield* decodePersistence(Settings, { personId: auth.person.id, theme: row.theme })
})

export const handlers = HttpApiBuilder.group(api, 'vivid', (groupHandlers) =>
  groupHandlers
    .handle('me', () => handleMe())
    .handle('listCompanies', () => handleListCompanies())
    .handle('createCompany', ({ payload }) => handleCreateCompany(payload))
    .handle('listProjects', () => handleListProjects())
    .handle('createProject', ({ payload }) => handleCreateProject(payload))
    .handle('inviteMembership', ({ payload }) => handleInviteMembership(payload))
    .handle('acceptMembership', ({ payload }) => handleAcceptMembership(payload))
    .handle('getSettings', () => handleGetSettings())
    .handle('patchSettings', ({ payload }) => handlePatchSettings(payload)),
)

export const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlers),
  Layer.provide(authMiddlewareLayer),
)
