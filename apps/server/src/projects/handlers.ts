import * as Effect from 'effect/Effect'
import { ProjectListResponse, type CreateProjectRequest } from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { ProjectStore } from './store.ts'

const projects = Effect.fn('Projects.list')(function* (actor: Actor) {
  return new ProjectListResponse({ projects: yield* (yield* ProjectStore).list(actor) })
})

export const projectHandlers = {
  ListProjects: Effect.fn('Rpc.ListProjects')(function* () {
    return yield* projects(yield* requireActor())
  }),
  WatchProjects: () => live(projects),
  CreateProject: Effect.fn('Rpc.CreateProject')(function* (request: CreateProjectRequest) {
    const actor = yield* requireActor()
    const project = yield* (yield* ProjectStore).create(actor, request)
    yield* changed(actor)
    return project
  }),
}
