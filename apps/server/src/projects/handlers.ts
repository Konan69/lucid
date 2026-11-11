import * as Effect from 'effect/Effect'
import {
  ProjectChange,
  ProjectListResponse,
  type CreateProjectRequest,
  type ProjectId,
  type UpdateProjectRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { confirmedProof, resolveProof } from './evidence.ts'
import { ProjectStore, WorkChange } from './store.ts'

const projects = Effect.fn('Projects.list')(function* (actor: Actor) {
  return new ProjectListResponse({ projects: yield* (yield* ProjectStore).list(actor) })
})

/** A completion as the store applies it, once its proof is read from the conversation. */
const completion = (actor: Actor, id: ProjectId, change: Parameters<typeof resolveProof>[2]) =>
  Effect.map(resolveProof(actor, id, change), (proof): WorkChange =>
    WorkChange.cases.Complete.make({ proof }),
  )

/**
 * Turn the wire change into the stored one. Vivid's completion reads the conversation; the
 * Person's own completion cites them, so both reach the store as the same `Complete`.
 */
const workChange = (actor: Actor, request: UpdateProjectRequest) =>
  ProjectChange.match(request.change, {
    Define: ({ objective, nextStep }) =>
      Effect.succeed(WorkChange.cases.Define.make({ objective, nextStep })),
    Progress: ({ text, nextStep }) =>
      Effect.succeed(WorkChange.cases.Progress.make({ text, nextStep })),
    Complete: (change) => completion(actor, request.id, change),
    Confirm: (change) =>
      Effect.map(confirmedProof(actor, request.id, change), (proof) =>
        WorkChange.cases.Complete.make({ proof }),
      ),
  })

export const projectHandlers = {
  ListProjects: Effect.fn('Rpc.ListProjects')(function* () {
    return yield* projects(yield* requireActor())
  }),
  WatchProjects: () => live('WatchProjects', ['activity'], projects),
  CreateProject: Effect.fn('Rpc.CreateProject')(function* (request: CreateProjectRequest) {
    const actor = yield* requireActor()
    return yield* (yield* ProjectStore).create(actor, request)
  }),
  UpdateProject: Effect.fn('Rpc.UpdateProject')(function* (request: UpdateProjectRequest) {
    const actor = yield* requireActor()
    const change = yield* workChange(actor, request)
    return yield* (yield* ProjectStore).update(actor, request.id, request.expected, change)
  }),
}
