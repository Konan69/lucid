import { manifest, type BuiltinRuntimeName } from '@vivid/skills'
import { parseSkill } from '@vivid/agent-runtime/cell'
import { Effect, Option } from 'effect'
import type { SkillFile } from '@vivid/agent-runtime/cell'
import skill0 from '@vivid/skills/make-an-integration/SKILL.md'
import skill1 from '@vivid/skills/connect-a-service/SKILL.md'
import skill2 from '@vivid/skills/work-in-a-signed-in-browser/SKILL.md'
import skill3 from '@vivid/skills/deep-research/SKILL.md'
import skill4 from '@vivid/skills/triage-my-inbox/SKILL.md'
import skill5 from '@vivid/skills/draft-a-reply/SKILL.md'
import skill6 from '@vivid/skills/morning-brief/SKILL.md'
import skill7 from '@vivid/skills/find-time-and-schedule/SKILL.md'
import skill8 from '@vivid/skills/prepare-for-a-meeting/SKILL.md'
import skill9 from '@vivid/skills/chase-an-outcome/SKILL.md'
import skill10 from '@vivid/skills/remember-and-correct-preferences/SKILL.md'
import skill11 from '@vivid/skills/learn-how-we-do-this/SKILL.md'
import skill12 from '@vivid/skills/write-a-document/SKILL.md'
import skill13 from '@vivid/skills/check-a-deliverable/SKILL.md'
import skill14 from '@vivid/skills/wide-research/SKILL.md'
import skill15 from '@vivid/skills/plan-a-trip/SKILL.md'
import skill16 from '@vivid/skills/shop-for-something/SKILL.md'
import skill17 from '@vivid/skills/find-a-place/SKILL.md'
import skill18 from '@vivid/skills/make-a-booking/SKILL.md'
import skill19 from '@vivid/skills/forget-something/SKILL.md'
import skill20 from '@vivid/skills/first-conversation/SKILL.md'
import skill21 from '@vivid/skills/what-vivid-can-do/SKILL.md'
import skill22 from '@vivid/skills/find-pictures/SKILL.md'
import displays from '@vivid/skills/make-an-integration/references/displays.md'
import reminders from '@vivid/skills/make-an-integration/references/reminders.md'
import schedules from '@vivid/skills/make-an-integration/references/schedules.md'

/** Every manifest entry must ship its authored instructions in the Worker bundle. */
const markdown = {
  'make-an-integration': skill0,
  'connect-a-service': skill1,
  'work-in-a-signed-in-browser': skill2,
  'deep-research': skill3,
  'triage-my-inbox': skill4,
  'draft-a-reply': skill5,
  'morning-brief': skill6,
  'find-time-and-schedule': skill7,
  'prepare-for-a-meeting': skill8,
  'chase-an-outcome': skill9,
  'remember-and-correct-preferences': skill10,
  'learn-how-we-do-this': skill11,
  'write-a-document': skill12,
  'check-a-deliverable': skill13,
  'wide-research': skill14,
  'plan-a-trip': skill15,
  'shop-for-something': skill16,
  'find-a-place': skill17,
  'make-a-booking': skill18,
  'forget-something': skill19,
  'first-conversation': skill20,
  'what-vivid-can-do': skill21,
  'find-pictures': skill22,
} satisfies Record<BuiltinRuntimeName, string>

/** The reference files each skill ships, by the path its instructions name them. A skill absent
 * here ships none; one whose instructions point at a file missing here fails startup
 * (`parseSkill`), so a forgotten import cannot reach a Person as a dangling pointer. */
const references: Partial<Record<BuiltinRuntimeName, ReadonlyArray<SkillFile>>> = {
  'make-an-integration': [
    { name: 'references/displays.md', body: displays },
    { name: 'references/reminders.md', body: reminders },
    { name: 'references/schedules.md', body: schedules },
  ],
}

export const skills = Effect.forEach(manifest, (entry) =>
  parseSkill(
    markdown[entry.runtimeName],
    entry.runtimeName,
    Option.getOrElse(Option.fromUndefinedOr(references[entry.runtimeName]), () => []),
  ),
)
