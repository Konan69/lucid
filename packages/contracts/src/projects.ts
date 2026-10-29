import { Schema } from 'effect'
import { CompanyId, MessageId, PersonId, ProjectId, ThreadId } from './identity.js'

/** Every change to a Project's work compares the revision the writer read; a new Project is 0. */
export const ProjectRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('ProjectRevision'),
)
export type ProjectRevision = typeof ProjectRevision.Type

/**
 * Who wrote a line of a Project's work. The server derives it from the caller (`auth/access.ts`
 * `Actor`), never from arguments: a Person directly, or Vivid acting for a Person in one Thread.
 */
export const ProjectAuthor = Schema.TaggedUnion({
  Person: { personId: PersonId },
  Vivid: { personId: PersonId, threadId: ThreadId },
})
export type ProjectAuthor = typeof ProjectAuthor.Type

const ProjectText = Schema.NonEmptyString.check(Schema.isMaxLength(500), Schema.isPattern(/\S/u))

/** One dated line of where the work stands. The log only grows; a correction is a newer line. */
export const ProjectProgress = Schema.Struct({
  at: Schema.Finite,
  text: ProjectText,
  by: ProjectAuthor,
})
export type ProjectProgress = typeof ProjectProgress.Type

/**
 * What shows a Project is done. A message of a Thread the writer could read when it was cited:
 * the Person saying so, or Vivid's reply holding what it observed. A Company Member who cannot
 * open that Thread sees the link and is refused there, as with any Thread link.
 */
export const ProjectEvidence = Schema.TaggedUnion({
  ThreadMessage: { threadId: ThreadId, messageId: MessageId },
})
export type ProjectEvidence = typeof ProjectEvidence.Type

export const ProjectProof = Schema.Struct({
  summary: ProjectText,
  sources: Schema.NonEmptyArray(ProjectEvidence),
})
export type ProjectProof = typeof ProjectProof.Type

/**
 * Where a Project's work stands. `Unspecified` is a Project that only groups Threads, as every
 * Project made before this existed: it has no objective, and none is invented for it. `Active`
 * always has an objective and a next step. `Completed` has its proof and no next step.
 */
export const ProjectWork = Schema.TaggedUnion({
  Unspecified: {},
  Active: {
    objective: ProjectText,
    progress: Schema.Array(ProjectProgress),
    nextStep: ProjectText,
  },
  Completed: {
    objective: ProjectText,
    progress: Schema.Array(ProjectProgress),
    completedAt: Schema.Finite,
    proof: ProjectProof,
  },
})
export type ProjectWork = typeof ProjectWork.Type

export class Project extends Schema.Class<Project>('Project')(
  {
    id: ProjectId,
    /** The Company the Project lives in, or nothing for a Project in a personal space. */
    companyId: Schema.NullOr(CompanyId),
    name: Schema.String,
    parentProjectId: Schema.NullOr(ProjectId),
    createdBy: PersonId,
    /** How many Threads the asking Person can see filed here. */
    threadCount: Schema.Finite,
    /** The latest of its creation, a change to its work and a filed Thread moving. */
    updatedAt: Schema.Finite,
    work: ProjectWork,
    revision: ProjectRevision,
  },
  { title: 'Project' },
) {}

export class CreateProjectRequest extends Schema.Class<CreateProjectRequest>(
  'CreateProjectRequest',
)(
  {
    name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
    parentProjectId: Schema.NullOr(ProjectId),
  },
  { title: 'Create Project request' },
) {}

export class ProjectListResponse extends Schema.Class<ProjectListResponse>('ProjectListResponse')(
  {
    projects: Schema.Array(Project),
  },
  { title: 'Project list response' },
) {}

/** Opaque call identity the runtime supplies outside model arguments, as `DocumentToolCallId`. */
export const ProjectToolCallId = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand('ProjectToolCallId'),
)
export type ProjectToolCallId = typeof ProjectToolCallId.Type

/**
 * One change to a Project's work.
 *
 * `Define` sets or corrects the objective and next step, and reopens a Completed Project; the
 * progress log is kept. `Progress` adds a dated line and the next step after it. `Complete` is
 * Vivid's, from inside a Run: the server reads that Run's messages and cites the Person's message
 * (`said: 'person'`) or Vivid's own reply (`said: 'vivid'`) as the proof, so the model never
 * names a message and completion never rests on a source nobody can open.
 */
export const ProjectChange = Schema.TaggedUnion({
  Define: { objective: ProjectText, nextStep: ProjectText },
  Progress: { text: ProjectText, nextStep: ProjectText },
  Complete: {
    summary: ProjectText,
    toolCallId: ProjectToolCallId,
    said: Schema.Literals(['person', 'vivid']),
  },
})
export type ProjectChange = typeof ProjectChange.Type

export const UpdateProjectRequest = Schema.Struct({
  id: ProjectId,
  expected: ProjectRevision,
  change: ProjectChange,
})
export type UpdateProjectRequest = typeof UpdateProjectRequest.Type

/** The Project moved on since the writer read it. `actual` is its revision now; read it again. */
export class ProjectChanged extends Schema.TaggedError<ProjectChanged>()(
  'ProjectChanged',
  { id: ProjectId, expected: ProjectRevision, actual: ProjectRevision },
  { title: 'The Project changed while it was being updated' },
) {}

/** Progress and completion need an objective first; a Completed Project is reopened by Define. */
export class ProjectNotActive extends Schema.TaggedError<ProjectNotActive>()(
  'ProjectNotActive',
  { id: ProjectId },
  { title: 'The Project has no objective in progress' },
) {}

/** The Run's messages hold no message to cite, so the Project is not marked done. */
export class ProjectEvidenceMissing extends Schema.TaggedError<ProjectEvidenceMissing>()(
  'ProjectEvidenceMissing',
  { id: ProjectId },
  { title: 'No readable message shows the Project is done' },
) {}
