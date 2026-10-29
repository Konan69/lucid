import { and, count, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  NotFound,
  Project,
  ProjectAuthor,
  ProjectChange,
  ProjectChanged,
  ProjectNotActive,
  ProjectProof,
  ProjectRevision,
  type ProjectProgress,
  ProjectWork,
  Workspace,
  type CreateProjectRequest,
  type ProjectId,
} from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { projectTable } from './tables.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

type ProjectStoreError = DatabaseInfrastructureError | NotFound

const decodeProject = decodeStored(Project, 'Project')
const decodeWorkRow = decodeStored(
  Schema.Struct({ work: ProjectWork, revision: ProjectRevision }),
  'Project work',
)
const encodeWork = encodeStored(ProjectWork, 'Project work')

/**
 * A `ProjectChange` as the store applies it: completion carries the proof the handler resolved
 * from the Run's messages (`handlers.ts`), so the store never reads a conversation.
 */
export const WorkChange = Schema.TaggedUnion({
  Define: ProjectChange.cases.Define.fields,
  Progress: ProjectChange.cases.Progress.fields,
  Complete: { proof: ProjectProof },
})
export type WorkChange = typeof WorkChange.Type

/** Every change keeps the dated log; only Define may start from a Project that has no objective. */
const progressOf = (work: ProjectWork): ReadonlyArray<ProjectProgress> =>
  ProjectWork.match(work, {
    Unspecified: () => [],
    Active: ({ progress }) => progress,
    Completed: ({ progress }) => progress,
  })

/** The author is who is calling: the Person, or Vivid in the Thread its Run belongs to. */
const authorOf = (actor: Actor): ProjectAuthor =>
  Option.match(actor.threadId, {
    onNone: () => ProjectAuthor.cases.Person.make({ personId: actor.person.id }),
    onSome: (threadId) => ProjectAuthor.cases.Vivid.make({ personId: actor.person.id, threadId }),
  })

/**
 * The next work for one change at `at`. Define (re)starts the objective; Progress and Complete
 * move an Active Project only, because a line of progress or a proof with no objective to measure
 * it against says nothing.
 */
const advance = (
  id: ProjectId,
  work: ProjectWork,
  change: WorkChange,
  at: number,
  by: ProjectAuthor,
) =>
  WorkChange.match<Effect.Effect<ProjectWork, ProjectNotActive>>(change, {
    Define: ({ objective, nextStep }) =>
      Effect.succeed(
        ProjectWork.cases.Active.make({ objective, nextStep, progress: progressOf(work) }),
      ),
    Progress: ({ text, nextStep }) =>
      ProjectWork.guards.Active(work)
        ? Effect.succeed(
            ProjectWork.cases.Active.make({
              objective: work.objective,
              progress: [...work.progress, { at, text, by }],
              nextStep,
            }),
          )
        : Effect.fail(new ProjectNotActive({ id })),
    Complete: ({ proof }) =>
      ProjectWork.guards.Active(work)
        ? Effect.succeed(
            ProjectWork.cases.Completed.make({
              objective: work.objective,
              progress: work.progress,
              completedAt: at,
              proof,
            }),
          )
        : Effect.fail(new ProjectNotActive({ id })),
  })

export interface ProjectStoreService {
  /** Every Project in the Actor's workspace, newest first, with how much is filed in each. */
  readonly list: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<Project>, DatabaseInfrastructureError>
  readonly create: (
    actor: Actor,
    request: CreateProjectRequest,
  ) => Effect.Effect<Project, ProjectStoreError>
  /** One change to a visible Project's work, refused when it moved past `expected`. */
  readonly update: (
    actor: Actor,
    id: ProjectId,
    expected: ProjectRevision,
    change: WorkChange,
  ) => Effect.Effect<Project, ProjectStoreError | ProjectChanged | ProjectNotActive>
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

/** The decoded stored owner is the audience, even when a different Member writes Company data. */
const projectTopics = (project: Project): ReadonlyArray<Topic> =>
  project.companyId === null
    ? [Topic.person(project.createdBy)]
    : [Topic.company(project.companyId)]

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
      const worked = row.workedAt === null ? row.createdAt.getTime() : row.workedAt.getTime()
      const moved = inside === undefined || inside.movedAt === null ? worked : inside.movedAt
      return decodeProject({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        parentProjectId: row.parentProjectId,
        createdBy: row.createdBy,
        threadCount: inside === undefined ? 0 : inside.threads,
        updatedAt: Math.max(worked, moved),
        work: row.work,
        revision: row.revision,
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
    transaction: Transaction,
    actor: Actor,
    id: ProjectId,
  ) {
    const rows = yield* transaction
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(and(eq(projectTable.id, id), inWorkspace(actor)))
      .limit(1)
    return rows.length === 0 ? yield* new NotFound({ message: 'Parent Project not found' }) : id
  })

  /**
   * Parent visibility, insert, projection and live/changes.ts announce share the caller's tx.
   * Projection reads join through rc.116 SqlClient.make's fiber connection, even though filedIn
   * closes over Database. A failed projection or notice rolls back the Project.
   */
  const writeProject = Effect.fn('ProjectStore.write')(function* (
    tx: Transaction,
    actor: Actor,
    request: CreateProjectRequest,
  ) {
    if (request.parentProjectId !== null) yield* requireParent(tx, actor, request.parentProjectId)
    const rows = yield* tx
      .insert(projectTable)
      .values({
        id: crypto.randomUUID(),
        companyId: companyColumnOf(actor.workspace),
        name: request.name.trim(),
        parentProjectId: request.parentProjectId,
        createdBy: actor.person.id,
      })
      .returning()
    const projects = yield* toProjects([yield* returned(rows, 'Project')])
    const project = yield* returned(projects, 'Project')
    yield* announce(tx, projectTopics(project))
    return project
  })

  /** Give the parent check, Project write and announcement one commit or one rollback. */
  const create = Effect.fn('ProjectStore.create')(function* (
    actor: Actor,
    request: CreateProjectRequest,
  ) {
    return yield* database.transaction((tx) => writeProject(tx, actor, request))
  })

  /**
   * Lock the row, compare the revision, apply the change and announce, in one commit: two writers
   * that read the same revision cannot both land, and the loser is told the revision there is.
   */
  const update = Effect.fn('ProjectStore.update')(function* (
    actor: Actor,
    id: ProjectId,
    expected: ProjectRevision,
    change: WorkChange,
  ) {
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const condition = and(eq(projectTable.id, id), inWorkspace(actor))
        const rows = yield* tx.select().from(projectTable).where(condition).for('update')
        const row = rows[0]
        if (row === undefined) return yield* new NotFound({ message: 'Project not found' })
        const before = yield* decodeWorkRow(row)
        if (before.revision !== expected)
          return yield* new ProjectChanged({ id, expected, actual: before.revision })
        const at = yield* Clock.currentTimeMillis
        const work = yield* advance(id, before.work, change, at, authorOf(actor))
        const updated = yield* tx
          .update(projectTable)
          .set({
            work: yield* encodeWork(work),
            revision: before.revision + 1,
            workedAt: new Date(at),
          })
          .where(condition)
          .returning()
        const projects = yield* toProjects([yield* returned(updated, 'Project')])
        const project = yield* returned(projects, 'Project')
        yield* announce(tx, projectTopics(project))
        return project
      }),
    )
  })

  return ProjectStore.of({ list, create, update })
})

export const projectStoreLayer = Layer.effect(ProjectStore, makeProjectStore())
