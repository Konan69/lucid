import { Schema } from 'effect'
import { CompanyId, PersonId, ProjectId } from './identity.js'

export class Project extends Schema.Class<Project>('Project')(
  {
    id: ProjectId,
    companyId: CompanyId,
    name: Schema.String,
    parentProjectId: Schema.optional(ProjectId),
    createdBy: PersonId,
  },
  { title: 'Project' },
) {}

export class CreateProjectRequest extends Schema.Class<CreateProjectRequest>(
  'CreateProjectRequest',
)(
  {
    name: Schema.String,
    parentProjectId: Schema.optional(ProjectId),
  },
  { title: 'Create Project request' },
) {}

export class ProjectListResponse extends Schema.Class<ProjectListResponse>('ProjectListResponse')(
  {
    projects: Schema.Array(Project),
  },
  { title: 'Project list response' },
) {}
