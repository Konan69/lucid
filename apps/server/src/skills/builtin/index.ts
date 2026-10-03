import { Skill, SkillId, SkillOrigin, SkillScope } from '@vivid/contracts'
import { procedure as connect } from './connect.ts'
import { procedure as browser } from './browser.ts'
import { procedure as research } from './research.ts'
import { procedure as inbox } from './inbox.ts'
import { procedure as reply } from './reply.ts'
import { procedure as brief } from './brief.ts'
import { procedure as schedule } from './schedule.ts'
import { procedure as meeting } from './meeting.ts'
import { procedure as outcome } from './outcome.ts'
import { procedure as watch } from './watch.ts'
import { procedure as preferences } from './preferences.ts'
import { procedure as learn } from './learn.ts'
import { procedure as document } from './document.ts'
import { procedure as check } from './check.ts'
import { procedure as wide } from './wide.ts'
import { procedure as travel } from './travel.ts'
import { procedure as shopping } from './shopping.ts'
import { procedure as places } from './places.ts'
import { procedure as booking } from './booking.ts'
import { procedure as forgetting } from './forget.ts'
import { procedure as abilities } from './self.ts'
import { procedure as images } from './images.ts'

/** The release date is version evidence, independent of any Person or database row. */
const releasedAt = Date.UTC(2026, 9, 2)
export const procedures = [
  connect,
  browser,
  research,
  inbox,
  reply,
  brief,
  schedule,
  meeting,
  outcome,
  watch,
  preferences,
  learn,
  document,
  check,
  wide,
  travel,
  shopping,
  places,
  booking,
  forgetting,
  abilities,
  images,
]

/** Deterministic shipped identities are private lookup handles; runtime views project only words. */
export const builtins = procedures.map((procedure) =>
  Skill.make({
    id: SkillId.make(`builtin:${procedure.name.toLowerCase().replaceAll(' ', '-')}`),
    about: procedure.about,
    name: procedure.name,
    useWhen: procedure.useWhen,
    instructions: procedure.instructions,
    scope: SkillScope.cases.BuiltIn.make({}),
    origin: SkillOrigin.cases.BuiltIn.make({}),
    createdAt: releasedAt,
    updatedAt: releasedAt,
  }),
)

/** Name resolution folds case and whitespace just as the model's name inventory does. */
const key = (name: string) => name.trim().toLowerCase()

/** Saved visible procedures replace shipped names only inside the actor's readable scope. */
export const catalogue = (saved: ReadonlyArray<Skill>): ReadonlyArray<Skill> => {
  const overrides = new Set(saved.map((skill) => key(skill.name)))
  return [...saved, ...builtins.filter((skill) => !overrides.has(key(skill.name)))]
}

/** The summary makes precedence explicit without transporting attribution or instructions. */
export const summary = (skill: Skill) => {
  if (SkillScope.guards.BuiltIn(skill.scope))
    return `${skill.useWhen} Built into Vivid; a saved procedure of this name takes precedence for its Person or Company.`
  if (builtins.some((builtin) => key(builtin.name) === key(skill.name)))
    return `${skill.useWhen} This saved procedure overrides Vivid's built-in procedure for its Person or Company.`
  return skill.useWhen
}
