import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { and, desc, eq } from "drizzle-orm"
import {
  AcceptMembershipRequest,
  Company,
  CompanyId,
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
  Unauthenticated
} from "@vivid/contracts"
import { Database } from "./database.ts"
import { ServerConfig } from "./config.ts"
import { authEffect } from "./auth.ts"
import {
  companyTable,
  invitationTable,
  membershipTable,
  personTable,
  projectTable,
  sessionTable,
  settingsTable
} from "./schema.ts"

export interface AuthState {
  readonly person: Person
  readonly activeCompany?: Company
  readonly membership?: Membership
  readonly sessionId: string
}

export class AuthContext extends Context.Service<AuthContext, AuthState>()("vivid/AuthContext") {}

const errors = [
  Unauthenticated.pipe(HttpApiSchema.status(401)),
  Forbidden.pipe(HttpApiSchema.status(403)),
  NotFound.pipe(HttpApiSchema.status(404)),
  Conflict.pipe(HttpApiSchema.status(409)),
  DatabaseConstraintViolation.pipe(HttpApiSchema.status(409)),
  DatabaseUnavailable.pipe(HttpApiSchema.status(503)),
  DatabaseFailure.pipe(HttpApiSchema.status(500))
] as const

export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: AuthContext; requires: Database | ServerConfig }
>()("vivid/AuthMiddleware", { error: errors }) {}

const me = HttpApiEndpoint.get("me", "/me", { success: MeResponse, error: errors })
const listCompanies = HttpApiEndpoint.get("listCompanies", "/companies", { success: CompanyListResponse, error: errors })
const createCompany = HttpApiEndpoint.post("createCompany", "/companies", {
  payload: CreateCompanyRequest,
  success: Company.pipe(HttpApiSchema.status(201)),
  error: errors
})
const listProjects = HttpApiEndpoint.get("listProjects", "/projects", { success: ProjectListResponse, error: errors })
const createProject = HttpApiEndpoint.post("createProject", "/projects", {
  payload: CreateProjectRequest,
  success: Project.pipe(HttpApiSchema.status(201)),
  error: errors
})
const inviteMembership = HttpApiEndpoint.post("inviteMembership", "/memberships/invite", {
  payload: InviteMembershipRequest,
  success: InvitationResponse.pipe(HttpApiSchema.status(201)),
  error: errors
})
const acceptMembership = HttpApiEndpoint.post("acceptMembership", "/memberships/accept", {
  payload: AcceptMembershipRequest,
  success: Membership,
  error: errors
})
const getSettings = HttpApiEndpoint.get("getSettings", "/settings", { success: Settings, error: errors })
const patchSettings = HttpApiEndpoint.patch("patchSettings", "/settings", {
  payload: PatchSettingsRequest,
  success: Settings,
  error: errors
})

const ApiGroup = HttpApiGroup.make("vivid")
  .add(me, listCompanies, createCompany, listProjects, createProject, inviteMembership, acceptMembership, getSettings, patchSettings)
  .middleware(AuthMiddleware)

export const api = HttpApi.make("VividApi").add(ApiGroup).prefix("/api")

const fromPerson = (row: typeof personTable.$inferSelect): Person => new Person({
  id: row.id as Person["id"],
  name: row.name,
  email: row.email,
  image: row.image
})

const fromCompany = (row: typeof companyTable.$inferSelect): Company => new Company({
  id: row.id as Company["id"],
  name: row.name,
  slug: row.slug
})

const fromMembership = (row: typeof membershipTable.$inferSelect): Membership => new Membership({
  id: row.id as Membership["id"],
  companyId: row.companyId as CompanyId,
  personId: row.userId as Membership["personId"],
  role: row.role
})

const fromProject = (row: typeof projectTable.$inferSelect): Project => new Project({
  id: row.id as Project["id"],
  companyId: row.companyId as CompanyId,
  name: row.name,
  ...(row.parentProjectId === null ? {} : { parentProjectId: row.parentProjectId as Project["parentProjectId"] }),
  createdBy: row.createdBy as Project["createdBy"]
})

const requireActiveCompany = Effect.gen(function*() {
  const auth = yield* AuthContext
  if (auth.activeCompany === undefined || auth.membership === undefined) {
    return yield* Effect.fail(new Forbidden({ message: "An active Company is required" }))
  }
  return { auth, company: auth.activeCompany, membership: auth.membership }
})

export const authenticate = (headers: Headers) => Effect.gen(function*() {
  const auth = yield* authEffect
  const session = yield* (auth.getSession(headers) as unknown as Effect.Effect<{
    user: { id: string }
    session: { id: string }
  } | null, unknown, never>).pipe(
    Effect.mapError(() => new Unauthenticated({ message: "Invalid session" }))
  )
  if (session === null) {
    return yield* Effect.fail(new Unauthenticated({ message: "Authentication required" }))
  }
  const db = yield* Database
  const users = yield* db.run(db.select().from(personTable).where(eq(personTable.id, session.user.id)).limit(1))
  const personRow = users[0]
  if (personRow === undefined) {
    return yield* Effect.fail(new Unauthenticated({ message: "Person no longer exists" }))
  }
  const sessionRows = yield* db.run(db.select({ activeCompanyId: sessionTable.activeCompanyId })
    .from(sessionTable)
    .where(eq(sessionTable.id, session.session.id))
    .limit(1))
  const activeCompanyId = sessionRows[0]?.activeCompanyId
  let activeCompany: Company | undefined
  let membership: Membership | undefined
  if (activeCompanyId !== null && activeCompanyId !== undefined) {
    const rows = yield* db.run(db.select({ company: companyTable, membership: membershipTable })
      .from(membershipTable)
      .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
      .where(and(eq(membershipTable.companyId, activeCompanyId), eq(membershipTable.userId, personRow.id)))
      .limit(1))
    const active = rows[0]
    if (active !== undefined) {
      activeCompany = fromCompany(active.company)
      membership = fromMembership(active.membership)
    }
  }
  return {
    person: fromPerson(personRow),
    ...(activeCompany === undefined ? {} : { activeCompany }),
    ...(membership === undefined ? {} : { membership }),
    sessionId: session.session.id
  } satisfies AuthState
})

export const authMiddlewareLayer = Layer.succeed(
  AuthMiddleware,
  (httpEffect) => Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = new globalThis.Headers(Object.entries(request.headers))
    const auth = yield* authenticate(headers)
    return yield* Effect.provideService(httpEffect, AuthContext, auth)
  })
)

export const handlers = HttpApiBuilder.group(api, "vivid", (handlers) =>
  handlers
    .handle("me", () => Effect.gen(function*() {
      const auth = yield* AuthContext
      return new MeResponse({
        person: auth.person,
        ...(auth.activeCompany === undefined ? {} : { activeCompany: auth.activeCompany }),
        ...(auth.membership === undefined ? {} : { membership: auth.membership })
      })
    }))
    .handle("listCompanies", () => Effect.gen(function*() {
      const auth = yield* AuthContext
      const db = yield* Database
      const rows = yield* db.run(db.select({ company: companyTable }).from(membershipTable)
        .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
        .where(eq(membershipTable.userId, auth.person.id))
        .orderBy(desc(companyTable.createdAt)))
      return new CompanyListResponse({ companies: rows.map((row) => fromCompany(row.company)) })
    }))
    .handle("createCompany", ({ payload }) => Effect.gen(function*() {
      const auth = yield* AuthContext
      const db = yield* Database
      const existing = yield* db.run(db.select().from(companyTable).where(eq(companyTable.slug, payload.slug)).limit(1))
      if (existing.length > 0) return yield* Effect.fail(new Conflict({ message: "Company slug is already in use" }))
      const companyId = crypto.randomUUID()
      const companyRows = yield* db.transaction((tx) => Effect.gen(function*() {
        const inserted = yield* tx.insert(companyTable).values({ id: companyId, name: payload.name, slug: payload.slug }).returning()
        yield* tx.insert(membershipTable).values({ id: crypto.randomUUID(), companyId, userId: auth.person.id, role: "owner" })
        yield* tx.update(sessionTable).set({ activeCompanyId: companyId }).where(eq(sessionTable.id, auth.sessionId))
        return inserted
      }))
      const company = companyRows[0]
      if (company === undefined) return yield* Effect.fail(new Conflict({ message: "Company could not be created" }))
      return fromCompany(company)
    }))
    .handle("listProjects", () => Effect.gen(function*() {
      const { company } = yield* requireActiveCompany
      const db = yield* Database
      const rows = yield* db.run(db.select().from(projectTable)
        .where(eq(projectTable.companyId, company.id))
        .orderBy(desc(projectTable.createdAt)))
      return new ProjectListResponse({ projects: rows.map(fromProject) })
    }))
    .handle("createProject", ({ payload }) => Effect.gen(function*() {
      const { auth, company } = yield* requireActiveCompany
      const db = yield* Database
      if (payload.parentProjectId !== undefined) {
        const parent = yield* db.run(db.select().from(projectTable)
          .where(and(eq(projectTable.id, payload.parentProjectId), eq(projectTable.companyId, company.id))).limit(1))
        if (parent.length === 0) return yield* Effect.fail(new NotFound({ message: "Parent Project not found" }))
      }
      const rows = yield* db.run(db.insert(projectTable).values({
        id: crypto.randomUUID(),
        companyId: company.id,
        name: payload.name,
        parentProjectId: payload.parentProjectId,
        createdBy: auth.person.id
      }).returning())
      const project = rows[0]
      if (project === undefined) return yield* Effect.fail(new Conflict({ message: "Project could not be created" }))
      return fromProject(project)
    }))
    .handle("inviteMembership", ({ payload }) => Effect.gen(function*() {
      const { auth, company, membership } = yield* requireActiveCompany
      if (membership.role !== "owner" && membership.role !== "admin") {
        return yield* Effect.fail(new Forbidden({ message: "Only Company administrators can invite" }))
      }
      const db = yield* Database
      const rows = yield* db.run(db.insert(invitationTable).values({
        id: crypto.randomUUID(),
        companyId: company.id,
        email: payload.email,
        role: payload.role,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        inviterId: auth.person.id
      }).returning())
      const invitation = rows[0]
      if (invitation === undefined) return yield* Effect.fail(new Conflict({ message: "Invitation could not be created" }))
      return new InvitationResponse({ id: invitation.id, companyId: company.id as CompanyId, email: invitation.email, role: invitation.role, status: invitation.status })
    }))
    .handle("acceptMembership", ({ payload }) => Effect.gen(function*() {
      const auth = yield* AuthContext
      const db = yield* Database
      const rows = yield* db.run(db.select().from(invitationTable).where(eq(invitationTable.id, payload.invitationId)).limit(1))
      const invitation = rows[0]
      if (invitation === undefined) return yield* Effect.fail(new NotFound({ message: "Invitation not found" }))
      if (invitation.status !== "pending" || invitation.expiresAt < new Date() || invitation.email.toLowerCase() !== auth.person.email.toLowerCase()) {
        return yield* Effect.fail(new Forbidden({ message: "Invitation is not valid for this Person" }))
      }
      const already = yield* db.run(db.select().from(membershipTable)
        .where(and(eq(membershipTable.companyId, invitation.companyId), eq(membershipTable.userId, auth.person.id))).limit(1))
      if (already.length > 0) return yield* Effect.fail(new Conflict({ message: "Person is already a Member" }))
      const result = yield* db.transaction((tx) => Effect.gen(function*() {
        const inserted = yield* tx.insert(membershipTable).values({ id: crypto.randomUUID(), companyId: invitation.companyId, userId: auth.person.id, role: invitation.role }).returning()
        yield* tx.update(invitationTable).set({ status: "accepted" }).where(eq(invitationTable.id, invitation.id))
        yield* tx.update(sessionTable).set({ activeCompanyId: invitation.companyId }).where(eq(sessionTable.id, auth.sessionId))
        return inserted
      }))
      const member = result[0]
      if (member === undefined) return yield* Effect.fail(new Conflict({ message: "Membership could not be created" }))
      return fromMembership(member)
    }))
    .handle("getSettings", () => Effect.gen(function*() {
      const auth = yield* AuthContext
      const db = yield* Database
      const rows = yield* db.run(db.select().from(settingsTable).where(eq(settingsTable.personId, auth.person.id)).limit(1))
      const row = rows[0]
      if (row !== undefined) return new Settings({ personId: auth.person.id, theme: row.theme as "system" | "light" | "dark" })
      yield* db.run(db.insert(settingsTable).values({ personId: auth.person.id, theme: "system" }))
      return new Settings({ personId: auth.person.id, theme: "system" })
    }))
    .handle("patchSettings", ({ payload }) => Effect.gen(function*() {
      const auth = yield* AuthContext
      const db = yield* Database
      const current = yield* db.run(db.select().from(settingsTable).where(eq(settingsTable.personId, auth.person.id)).limit(1))
      const theme = payload.theme ?? (current[0]?.theme as "system" | "light" | "dark" | undefined) ?? "system"
      const rows = yield* db.run(db.insert(settingsTable).values({ personId: auth.person.id, theme })
        .onConflictDoUpdate({ target: settingsTable.personId, set: { theme, updatedAt: new Date() } }).returning())
      const row = rows[0]
      if (row === undefined) return yield* Effect.fail(new Conflict({ message: "Settings could not be saved" }))
      return new Settings({ personId: auth.person.id, theme: row.theme as "system" | "light" | "dark" })
    }))
)

export const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(handlers),
  Layer.provide(authMiddlewareLayer)
)
