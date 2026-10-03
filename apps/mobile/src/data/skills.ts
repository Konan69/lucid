import {
  SkillScope,
  type PatchSkillRequest,
  type SaveSkillRequest,
  type Skill,
  type SkillId,
} from '@vivid/contracts'
import type { LiveData } from './live'

/**
 * What the Skills manager can do, and nothing else: read the list live (`data.live.skills`),
 * save a new skill, change one, and forget one. These are the server's own calls (`SaveSkill`,
 * `PatchSkill`, `DeleteSkill`); the screen reaches them only through here, so when skills move
 * into the runtime this file is what changes and the screen is not.
 *
 * What the server does not offer is not offered here either: turning a built-in off, adding a
 * skill from a file or a link, and seeing where a skill came from have no call behind them.
 */

/** A skill the Person or their Company saved, as opposed to one that ships with Vivid. */
export const isSaved = (skill: Skill): boolean => !SkillScope.guards.BuiltIn(skill.scope)

/** Saves a new skill. The live list shows it when the server's next result arrives. */
export const saveSkill = (data: LiveData, request: SaveSkillRequest) =>
  data.change((client) => client.SaveSkill(request))

/** Changes a saved skill, shown at once and put back if the server refuses. */
export const patchSkill = (data: LiveData, id: SkillId, patch: PatchSkillRequest) =>
  data.change(
    (client) => client.PatchSkill({ id, patch }),
    () =>
      data.live.skills.expect((current) => ({
        skills: current.skills.map((skill) =>
          skill.id === id ? Object.assign({}, skill, patch) : skill,
        ),
      })),
  )

/** Forgets a saved skill. It leaves the list at once and comes back if the server refuses. */
export const forgetSkill = (data: LiveData, id: SkillId) =>
  data.change(
    (client) => client.DeleteSkill({ id }),
    () =>
      data.live.skills.expect((current) => ({
        skills: current.skills.filter((kept) => kept.id !== id),
      })),
  )
