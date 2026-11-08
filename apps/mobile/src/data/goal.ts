import { useAtomValue } from '@effect/atom-react'
import type { ProjectId, ProjectListResponse, UpdateProjectRequest } from '@vivid/contracts'
import { goal, projects, type LiveQuery, type makeLive } from '@vivid/state'
import { Effect, Layer, Predicate, Result } from 'effect'
import { confirm } from './haptics'
import { useLiveData, type LiveData } from './live'

/**
 * The Person setting a Project's goal or marking it done from its page (`@vivid/state` `goal`),
 * one machine for the session as the web app has one for the page. The Project the server answers
 * with goes into the session's live list at once, before the live query's next result.
 */
export const makeGoal = (
  engine: ReturnType<typeof makeLive>,
  list: LiveQuery<ProjectListResponse>,
) => {
  const setting = goal.make(
    Layer.succeed(goal.Setting, {
      update: Effect.fn('Goal.update')(function* (request: UpdateProjectRequest) {
        // The call's own refusals are kept in the value: they say why, and the sheet words each.
        const answer = yield* engine.change((client) =>
          Effect.result(client.UpdateProject(request)),
        )
        const result = Result.flatMap(answer, (inner) => inner)
        if (Result.isFailure(result)) {
          const moved =
            Predicate.isTagged(result.failure, 'ProjectChanged') ||
            Predicate.isTagged(result.failure, 'ProjectNotActive')
          return yield* new goal.Refused({ reason: moved ? 'Changed' : 'Failed' })
        }
        list.expect(projects.revised(result.success))(true)
      }),
    }),
  )
  // The sheet closing does not lose a refusal: the session holds the machine.
  engine.registry.mount(setting.reading)
  return setting
}

/** Where the goal sheet stands. */
export const useGoal = () => {
  const data = useLiveData()
  return useAtomValue(data.goal.reading)
}

/** The Person pressed to set the goal or mark it done, or closed the sheet. */
export const openGoal = (data: LiveData, projectId: ProjectId, form: goal.Form) =>
  data.registry.set(data.goal.send, data.goal.open({ projectId, form }))
export const closeGoal = (data: LiveData) => data.registry.set(data.goal.send, data.goal.close())

/** Save, with a request the sheet already checked. A second press while saving is not taken. */
export const saveGoal = (data: LiveData, request: UpdateProjectRequest) => {
  confirm()
  data.registry.set(data.goal.send, data.goal.save({ request }))
}
