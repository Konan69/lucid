import { and, count, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  NotFound,
  Project,
  Workspace,
  type CreateProjectRequest,
  type ProjectId,
} from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { threads } from '../threads/tables.ts'
import { projectTable } from './tables.ts'

type ProjectStoreError = DatabaseInfrastructureError | NotFound

const decodeProject = decodeStored(Project, 'Project')

export interface ProjectStoreService {
  /** Every Project in the Actor's workspace, newest first, with how much is filed in each. */
  readonly list: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<Project>, DatabaseInfrastructureError>
  readonly create: (
    actor: Actor,
    request: CreateProjectRequest,
  ) => Effect.Effect<Project, ProjectStoreError>
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreService>()(
  'vivid/ProjectStore',
) {}

/**
 * A Project belongs to a workspace: a Person's own space (no Company, and only its creator), or a
 * Company, where every Member sees it. The Threads filed in it keep their own audience, so the
 * count a Member sees includes Threads they cannot open; a Project says how much work it holds,
 * not what the work is.
 */
const inWorkspace = (actor: Actor) =>
  Workspace.match(actor.workspace, {
    Personal: () =>
      and(isNull(projectTable.companyId), eq(projectTable.createdBy, actor.person.id)),
    Company: ({ company }) => eq(projectTable.companyId, company.id),
  })

type Row = typeof projectTable.$inferSelect

/** What is filed in each of these Projects: how many Threads, and when one last moved. */
const filedIn = Effect.fn('ProjectStore.filedIn')(function* (
  database: Database['Service'],
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return new Map<string, { threads: number; movedAt: number | null }>()
  const rows = yield* database.run(
    database
      .select({ projectId: threads.projectId, threads: count(), movedAt: max(threads.updatedAt) })
      .from(threads)
      .where(inArray(threads.projectId, ids))
      .groupBy(threads.projectId),
  )
  return new Map(rows.map((row) => [row.projectId, row] as const))
})

const makeProjectStore = Effect.fn('ProjectStore.make')(function* () {
  const database = yield* Database

  const toProjects = Effect.fn('ProjectStore.toProjects')(function* (rows: ReadonlyArray<Row>) {
    const filed = yield* filedIn(
      database,
      rows.map((row) => row.id),
    )
    return yield* Effect.forEach(rows, (row) => {
      const inside = filed.get(row.id)
      const created = row.createdAt.getTime()
      return decodeProject({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        parentProjectId: row.parentProjectId,
        createdBy: row.createdBy,
        threadCount: inside === undefined ? 0 : inside.threads,
        updatedAt: inside === undefined || inside.movedAt === null ? created : inside.movedAt,
      })
    })
  })

  const list = Effect.fn('ProjectStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(projectTable)
        .where(inWorkspace(actor))
        .orderBy(desc(projectTable.createdAt)),
    )
    return yield* toProjects(rows)
  })

  /** A parent must be a Project the Actor can see; one in another workspace does not exist here. */
  const requireParent = Effect.fn('ProjectStore.requireParent')(function* (
    actor: Actor,
    id: ProjectId,
  ) {
    const rows = yield* database.run(
      database
        .select({ id: projectTable.id })
        .from(projectTable)
        .where(and(eq(projectTable.id, id), inWorkspace(actor)))
        .limit(1),
    )
    return rows.length === 0
      ? yield* Effect.fail(new NotFound({ message: 'Parent Project not found' }))
      : id
  })

  const create = Effect.fn('ProjectStore.create')(function* (
    actor: Actor,
    request: CreateProjectRequest,
  ) {
    if (request.parentProjectId !== null) yield* requireParent(actor, request.parentProjectId)
    const rows = yield* database.run(
      database
        .insert(projectTable)
        .values({
          id: crypto.randomUUID(),
          companyId: companyColumnOf(actor.workspace),
          name: request.name.trim(),
          parentProjectId: request.parentProjectId,
          createdBy: actor.person.id,
        })
        .returning(),
    )
    const projects = yield* toProjects([yield* returned(rows, 'Project')])
    return yield* returned(projects, 'Project')
  })

  return ProjectStore.of({ list, create })
})

export const projectStoreLayer = Layer.effect(ProjectStore, makeProjectStore())
