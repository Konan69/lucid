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
}) {}

export class Session extends Schema.Class<Session>("Session")({
  id: SessionId,
  personId: PersonId,
  activeCompanyId: Schema.optional(CompanyId),
  expiresAt: Schema.DateTimeUtc
}) {}

export class Company extends Schema.Class<Company>("Company")({
  id: CompanyId,
  name: Schema.String,
  slug: Schema.String
}) {}

export class Membership extends Schema.Class<Membership>("Membership")({
  id: MembershipId,
  companyId: CompanyId,
  personId: PersonId,
  role: Schema.String
}) {}

export class Project extends Schema.Class<Project>("Project")({
  id: ProjectId,
  companyId: CompanyId,
  name: Schema.String,
  parentProjectId: Schema.optional(ProjectId),
  createdBy: PersonId
}) {}

export class Settings extends Schema.Class<Settings>("Settings")({
  personId: PersonId,
  theme: Schema.Literals(["system", "light", "dark"] as const)
}) {}

export class CreateCompanyRequest extends Schema.Class<CreateCompanyRequest>("CreateCompanyRequest")({
  name: Schema.String,
  slug: Schema.String
}) {}

export class CreateProjectRequest extends Schema.Class<CreateProjectRequest>("CreateProjectRequest")({
  name: Schema.String,
  parentProjectId: Schema.optional(ProjectId)
}) {}

export class InviteMembershipRequest extends Schema.Class<InviteMembershipRequest>("InviteMembershipRequest")({
  email: Schema.String,
  role: Schema.String
}) {}

export class AcceptMembershipRequest extends Schema.Class<AcceptMembershipRequest>("AcceptMembershipRequest")({
  invitationId: Schema.String
}) {}

export class PatchSettingsRequest extends Schema.Class<PatchSettingsRequest>("PatchSettingsRequest")({
  theme: Schema.optional(Schema.Literals(["system", "light", "dark"] as const))
}) {}

export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
  person: Person,
  activeCompany: Schema.optional(Company),
  membership: Schema.optional(Membership)
}) {}

export class CompanyListResponse extends Schema.Class<CompanyListResponse>("CompanyListResponse")({
  companies: Schema.Array(Company)
}) {}

export class ProjectListResponse extends Schema.Class<ProjectListResponse>("ProjectListResponse")({
  projects: Schema.Array(Project)
}) {}

export class InvitationResponse extends Schema.Class<InvitationResponse>("InvitationResponse")({
  id: Schema.String,
  companyId: CompanyId,
  email: Schema.String,
  role: Schema.String,
  status: Schema.String
}) {}


export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String
}) {}

/** Infrastructure failures exposed without leaking driver-specific errors. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()("DatabaseUnavailable", {
  message: Schema.String
}) {}

export class DatabaseConstraintViolation extends Schema.TaggedError<DatabaseConstraintViolation>()("DatabaseConstraintViolation", {
  message: Schema.String
}) {}

export class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()("DatabaseFailure", {
  message: Schema.String
}) {}

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
