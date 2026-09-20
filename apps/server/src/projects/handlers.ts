import * as Effect from 'effect/Effect'
import { ProjectListResponse, type CreateProjectRequest } from '@vivid/contracts'
import { requireActiveCompany } from '../auth/session.ts'
import { ProjectStore } from './store.ts'

export const listProjects = Effect.fn('Api.listProjects')(function* () {
  const { company } = yield* requireActiveCompany()
  const store = yield* ProjectStore
  return new ProjectListResponse({ projects: yield* store.list(company.id) })
})
export const createProject = Effect.fn('Api.createProject')(function* (
  payload: CreateProjectRequest,
) {
  const { auth, company } = yield* requireActiveCompany()
  const store = yield* ProjectStore
  return yield* store.create(company.id, auth.person.id, payload)
})
