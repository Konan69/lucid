import type { SkillReference } from '@flue/runtime'
import { manifest, type BuiltinRuntimeName } from './manifest.ts'
import connectAService from '../connect-a-service/SKILL.md'
import workInASignedInBrowser from '../work-in-a-signed-in-browser/SKILL.md'
import deepResearch from '../deep-research/SKILL.md'
import triageMyInbox from '../triage-my-inbox/SKILL.md'
import draftAReply from '../draft-a-reply/SKILL.md'
import morningBrief from '../morning-brief/SKILL.md'
import findTimeAndSchedule from '../find-time-and-schedule/SKILL.md'
import prepareForAMeeting from '../prepare-for-a-meeting/SKILL.md'
import chaseAnOutcome from '../chase-an-outcome/SKILL.md'
import watchAUsefulSignal from '../watch-a-useful-signal/SKILL.md'
import rememberAndCorrectPreferences from '../remember-and-correct-preferences/SKILL.md'
import learnHowWeDoThis from '../learn-how-we-do-this/SKILL.md'
import writeADocument from '../write-a-document/SKILL.md'
import checkADeliverable from '../check-a-deliverable/SKILL.md'
import wideResearch from '../wide-research/SKILL.md'
import planATrip from '../plan-a-trip/SKILL.md'
import shopForSomething from '../shop-for-something/SKILL.md'
import findAPlace from '../find-a-place/SKILL.md'
import makeABooking from '../make-a-booking/SKILL.md'
import forgetSomething from '../forget-something/SKILL.md'
import whatVividCanDo from '../what-vivid-can-do/SKILL.md'
import findPictures from '../find-pictures/SKILL.md'

/** Static imports let Flue validate and bundle each folder. Total key coverage follows the manifest. */
export const nativeSkills = {
  'connect-a-service': connectAService,
  'work-in-a-signed-in-browser': workInASignedInBrowser,
  'deep-research': deepResearch,
  'triage-my-inbox': triageMyInbox,
  'draft-a-reply': draftAReply,
  'morning-brief': morningBrief,
  'find-time-and-schedule': findTimeAndSchedule,
  'prepare-for-a-meeting': prepareForAMeeting,
  'chase-an-outcome': chaseAnOutcome,
  'watch-a-useful-signal': watchAUsefulSignal,
  'remember-and-correct-preferences': rememberAndCorrectPreferences,
  'learn-how-we-do-this': learnHowWeDoThis,
  'write-a-document': writeADocument,
  'check-a-deliverable': checkADeliverable,
  'wide-research': wideResearch,
  'plan-a-trip': planATrip,
  'shop-for-something': shopForSomething,
  'find-a-place': findAPlace,
  'make-a-booking': makeABooking,
  'forget-something': forgetSomething,
  'what-vivid-can-do': whatVividCanDo,
  'find-pictures': findPictures,
} satisfies Record<BuiltinRuntimeName, SkillReference>

/** One immutable manifest order is used for every render, independent of Person or preload state. */
export const nativeSkillsInOrder = manifest.map((entry) => nativeSkills[entry.runtimeName])
