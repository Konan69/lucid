import { and, desc, eq } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { Conflict, NotFound, Project, type CompanyId, type CreateProjectRequest, type PersonId } from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { projectTable } from './tables.ts'

const decodeProject = (value: unknown) => Schema.decodeUnknownEffect(Project)(value).pipe(
  Effect.mapError(() => new Conflict({ message: 'Stored Project data is invalid' })),
)
type ProjectStoreError = DatabaseInfrastructureError | Conflict | NotFound

export interface ProjectStoreService {
  readonly list: (companyId: CompanyId) => Effect.Effect<ReadonlyArray<Project>, ProjectStoreError>
  readonly create: (companyId: CompanyId, personId: PersonId, request: CreateProjectRequest) => Effect.Effect<Project, ProjectStoreError>
}
export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreService>()('vivid/ProjectStore') {}

export const projectStoreLayer = Layer.effect(ProjectStore, Effect.gen(function* () {
  const database = yield* Database
  const list = Effect.fn('ProjectStore.list')(function* (companyId: CompanyId) {
    const rows = yield* database.run(database.select().from(projectTable).where(eq(projectTable.companyId, companyId)).orderBy(desc(projectTable.createdAt)))
    return yield* Effect.forEach(rows, (row) => decodeProject({ id: row.id, companyId: row.companyId, name: row.name, createdBy: row.createdBy, ...(row.parentProjectId === null ? {} : { parentProjectId: row.parentProjectId }) }))
  })
  const create = Effect.fn('ProjectStore.create')(function* (companyId: CompanyId, personId: PersonId, request: CreateProjectRequest) {
    if (request.parentProjectId !== undefined) {
      const parent = yield* database.run(database.select({ id: projectTable.id }).from(projectTable).where(and(eq(projectTable.id, request.parentProjectId), eq(projectTable.companyId, companyId))).limit(1))
      if (parent.length === 0) return yield* Effect.fail(new NotFound({ message: 'Parent Project not found' }))
    }
    const rows = yield* database.run(database.insert(projectTable).values({ id: crypto.randomUUID(), companyId, name: request.name, parentProjectId: request.parentProjectId, createdBy: personId }).returning())
    const row = rows[0]
    if (row === undefined) return yield* Effect.fail(new Conflict({ message: 'Project could not be created' }))
    return yield* decodeProject({ id: row.id, companyId: row.companyId, name: row.name, createdBy: row.createdBy, ...(row.parentProjectId === null ? {} : { parentProjectId: row.parentProjectId }) })
  })
  return ProjectStore.of({ list, create })
}))
