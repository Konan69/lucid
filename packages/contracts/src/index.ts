import { Schema } from "effect"

export * from "./runtime.js"

const id = (name: string) => Schema.String.pipe(Schema.brand(name))

export const PersonId = id("PersonId")
export type PersonId = typeof PersonId.Type
export const SessionId = id("SessionId")
export type SessionId = typeof SessionId.Type
export const CompanyId = id("CompanyId")
export type CompanyId = typeof CompanyId.Type
export const MembershipId = id("MembershipId")
export type MembershipId = typeof MembershipId.Type
export const ProjectId = id("ProjectId")
export type ProjectId = typeof ProjectId.Type

export class Person extends Schema.Class<Person>("Person")({
  id: PersonId,
  name: Schema.String,
  email: Schema.String,
  image: Schema.optional(Schema.NullOr(Schema.String))
}, { title: "Person" }) {}

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  personId: PersonId,
  activeCompanyId: Schema.optional(CompanyId),
  expiresAt: Schema.DateTimeUtc
}, { title: "Session" }) {}

export class Company extends Schema.Class<Company>("Company")({
  id: CompanyId,
  name: Schema.String,
  slug: Schema.String
}, { title: "Company" }) {}

export class Membership extends Schema.Class<Membership>("Membership")({
  id: MembershipId,
  companyId: CompanyId,
  personId: PersonId,
  role: Schema.String
}, { title: "Membership" }) {}

export class Project extends Schema.Class<Project>("Project")({
  id: ProjectId,
  companyId: CompanyId,
  name: Schema.String,
  parentProjectId: Schema.optional(ProjectId),
  createdBy: PersonId
}, { title: "Project" }) {}

export class Settings extends Schema.Class<Settings>("Settings")({
  personId: PersonId,
  theme: Schema.Literals(["system", "light", "dark"] as const)
}, { title: "Settings" }) {}

export class CreateCompanyRequest extends Schema.Class<CreateCompanyRequest>("CreateCompanyRequest")({
  name: Schema.String,
  slug: Schema.String
}, { title: "Create Company request" }) {}

export class CreateProjectRequest extends Schema.Class<CreateProjectRequest>("CreateProjectRequest")({
  name: Schema.String,
  parentProjectId: Schema.optional(ProjectId)
}, { title: "Create Project request" }) {}

export class InviteMembershipRequest extends Schema.Class<InviteMembershipRequest>("InviteMembershipRequest")({
  email: Schema.String,
  role: Schema.String
}, { title: "Invite Membership request" }) {}

export class AcceptMembershipRequest extends Schema.Class<AcceptMembershipRequest>("AcceptMembershipRequest")({
  invitationId: Schema.String
}, { title: "Accept Membership request" }) {}

export class PatchSettingsRequest extends Schema.Class<PatchSettingsRequest>("PatchSettingsRequest")({
  theme: Schema.optional(Schema.Literals(["system", "light", "dark"] as const))
}, { title: "Patch Settings request" }) {}

export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
  person: Person,
  activeCompany: Schema.optional(Company),
  membership: Schema.optional(Membership)
}, { title: "Current Person response" }) {}

export class CompanyListResponse extends Schema.Class<CompanyListResponse>("CompanyListResponse")({
  companies: Schema.Array(Company)
}, { title: "Company list response" }) {}

export class ProjectListResponse extends Schema.Class<ProjectListResponse>("ProjectListResponse")({
  projects: Schema.Array(Project)
}, { title: "Project list response" }) {}

export class InvitationResponse extends Schema.Class<InvitationResponse>("InvitationResponse")({
  id: Schema.String,
  companyId: CompanyId,
  email: Schema.String,
  role: Schema.String,
  status: Schema.String
}, { title: "Invitation response" }) {}


export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String
}, { title: "Unauthenticated" }) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}, { title: "Forbidden" }) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String
}, { title: "Not found" }) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String
}, { title: "Conflict" }) {}

/** Infrastructure failures exposed without leaking driver-specific errors. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()("DatabaseUnavailable", {
  message: Schema.String
}, { title: "Database unavailable" }) {}

export class DatabaseConstraintViolation extends Schema.TaggedError<DatabaseConstraintViolation>()("DatabaseConstraintViolation", {
  message: Schema.String
}, { title: "Database constraint violation" }) {}

export class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()("DatabaseFailure", {
  message: Schema.String
}, { title: "Database failure" }) {}

export const ApiError = Schema.Union([
  Unauthenticated,
  Forbidden,
  NotFound,
  Conflict,
  DatabaseUnavailable,
  DatabaseConstraintViolation,
  DatabaseFailure
])
export type ApiError = typeof ApiError.Type
