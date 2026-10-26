/**
 * The built-in skills' SKILL.md texts, bundled with the cell as text (`rules` in `wrangler.jsonc`).
 * A cell's `node:fs` reads only its own bundle, so the runtime's `loadSkills`, which reads the
 * files from the installed `@vivid/skills` package, cannot run here. Generated from the manifest;
 * `skills.ts` refuses to start when an entry has no text, so a skill added there fails loudly.
 */
import makeAnIntegration from '@vivid/skills/make-an-integration/SKILL.md'
import connectAService from '@vivid/skills/connect-a-service/SKILL.md'
import workInASignedInBrowser from '@vivid/skills/work-in-a-signed-in-browser/SKILL.md'
import deepResearch from '@vivid/skills/deep-research/SKILL.md'
import triageMyInbox from '@vivid/skills/triage-my-inbox/SKILL.md'
import draftAReply from '@vivid/skills/draft-a-reply/SKILL.md'
import morningBrief from '@vivid/skills/morning-brief/SKILL.md'
import findTimeAndSchedule from '@vivid/skills/find-time-and-schedule/SKILL.md'
import prepareForAMeeting from '@vivid/skills/prepare-for-a-meeting/SKILL.md'
import chaseAnOutcome from '@vivid/skills/chase-an-outcome/SKILL.md'
import rememberAndCorrectPreferences from '@vivid/skills/remember-and-correct-preferences/SKILL.md'
import learnHowWeDoThis from '@vivid/skills/learn-how-we-do-this/SKILL.md'
import writeADocument from '@vivid/skills/write-a-document/SKILL.md'
import checkADeliverable from '@vivid/skills/check-a-deliverable/SKILL.md'
import wideResearch from '@vivid/skills/wide-research/SKILL.md'
import planATrip from '@vivid/skills/plan-a-trip/SKILL.md'
import shopForSomething from '@vivid/skills/shop-for-something/SKILL.md'
import findAPlace from '@vivid/skills/find-a-place/SKILL.md'
import makeABooking from '@vivid/skills/make-a-booking/SKILL.md'
import forgetSomething from '@vivid/skills/forget-something/SKILL.md'
import firstConversation from '@vivid/skills/first-conversation/SKILL.md'
import whatVividCanDo from '@vivid/skills/what-vivid-can-do/SKILL.md'
import findPictures from '@vivid/skills/find-pictures/SKILL.md'

export const texts: ReadonlyMap<string, string> = new Map([
  ['make-an-integration', makeAnIntegration],
  ['connect-a-service', connectAService],
  ['work-in-a-signed-in-browser', workInASignedInBrowser],
  ['deep-research', deepResearch],
  ['triage-my-inbox', triageMyInbox],
  ['draft-a-reply', draftAReply],
  ['morning-brief', morningBrief],
  ['find-time-and-schedule', findTimeAndSchedule],
  ['prepare-for-a-meeting', prepareForAMeeting],
  ['chase-an-outcome', chaseAnOutcome],
  ['remember-and-correct-preferences', rememberAndCorrectPreferences],
  ['learn-how-we-do-this', learnHowWeDoThis],
  ['write-a-document', writeADocument],
  ['check-a-deliverable', checkADeliverable],
  ['wide-research', wideResearch],
  ['plan-a-trip', planATrip],
  ['shop-for-something', shopForSomething],
  ['find-a-place', findAPlace],
  ['make-a-booking', makeABooking],
  ['forget-something', forgetSomething],
  ['first-conversation', firstConversation],
  ['what-vivid-can-do', whatVividCanDo],
  ['find-pictures', findPictures],
])
