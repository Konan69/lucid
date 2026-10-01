import { Schema } from 'effect'
import { CompanyId, PersonId, ProjectId } from './identity.js'

export class Project extends Schema.Class<Project>('Project')(
  {
    id: ProjectId,
    /** The Company the Project lives in, or nothing for a Project in a personal space. */
    companyId: Schema.NullOr(CompanyId),
    name: Schema.String,
    parentProjectId: Schema.NullOr(ProjectId),
    createdBy: PersonId,
    /** How many Threads the asking Person can see filed here. */
    threadCount: Schema.Number,
    updatedAt: Schema.Number,
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
