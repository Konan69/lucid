import { useAtomValue } from '@effect/atom-react'
import type { ProjectId, UpdateProjectRequest } from '@vivid/contracts'
import { goal, projects } from '@vivid/state'
import { Effect, Layer, Predicate, Result } from 'effect'
import { changing } from './app'
import { live } from './live'
import { engine } from './runtime'

/**
 * The Person setting a Project's goal or marking it done from its page (`@vivid/state` `goal`).
 * The Project the server answers with goes into the live list at once, so the page shows the new
 * goal or "Done" before the live query's next result arrives.
 */
const setting = goal.make(
  Layer.succeed(goal.Setting, {
    update: Effect.fn('Goal.update')(function* (request: UpdateProjectRequest) {
      // The call's own refusals are kept in the value: they say why, and the form words each.
      const answer = yield* changing((client) => Effect.result(client.UpdateProject(request)))
      const result = Result.flatMap(answer, (inner) => inner)
      if (Result.isFailure(result)) {
        const moved =
          Predicate.isTagged(result.failure, 'ProjectChanged') ||
          Predicate.isTagged(result.failure, 'ProjectNotActive')
        return yield* new goal.Refused({ reason: moved ? 'Changed' : 'Failed' })
      }
      live.projects.expect(projects.revised(result.success))(true)
    }),
  }),
)

// The form is a dialog on the Project's page; a refusal outlives it being drawn again.
engine.registry.mount(setting.reading)

/** Where the goal form stands, the same for every screen that shows it. */
export const useGoal = () => useAtomValue(setting.reading)

/** The Person pressed to set the goal or mark it done, or closed the form. */
export const openGoal = (projectId: ProjectId, form: goal.Form) =>
  engine.registry.set(setting.send, setting.open({ projectId, form }))
export const closeGoal = () => engine.registry.set(setting.send, setting.close())

/** Save, with a request the form already checked. A second press while saving is not taken. */
export const saveGoal = (request: UpdateProjectRequest) =>
  engine.registry.set(setting.send, setting.save({ request }))
