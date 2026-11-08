import { Schema } from 'effect'
import { ThreadId } from './identity.js'

/**
 * Why the Dreamer ran. `Night` is the one pass a night at 03:00 in the Person's time zone, which
 * re-reads the day and re-orients priorities; `Quiet` is the bounded pass after a long
 * conversation went quiet. The Dreamer is ported from Dots' Heartbeat Dreamer and nightly
 * reflection run (`dots/dreamer.md`, "Nightly Reflection Runs") and Muse's dreaming and
 * quiet-moment pass (`muse/docs/self_improvement.md:7`), as the owner decided on 27 October 2026
 * (docs/28, section 5).
 */
export const DreamPass = Schema.Literals(['Night', 'Quiet'])
export type DreamPass = typeof DreamPass.Type

/**
 * The cell's own name for one Dreamer run, unique within the Person's cell. The server derives the
 * run's Background Thread from it and the Person, so asking twice opens the same Thread.
 */
export const DreamKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9:-]{0,79}$/u)).pipe(
  Schema.brand('DreamKey'),
)
export type DreamKey = typeof DreamKey.Type

/** Open the Background Thread one Dreamer run reads in. The Person and workspace are the caller's. */
export const OpenDreamRequest = Schema.Struct({ key: DreamKey, pass: DreamPass })
export type OpenDreamRequest = typeof OpenDreamRequest.Type
export const OpenDreamResponse = Schema.Struct({ threadId: ThreadId })
export type OpenDreamResponse = typeof OpenDreamResponse.Type

/**
 * What the Dreamer learned that is useful and new, or the blocker the Person must clear, as it
 * wrote it for Vivid: deadlines first. Reported from the dream's own Thread, where Vivid reads it
 * the way it reads a Watch firing and decides whether it becomes one card on the Feed.
 */
export const DreamFinding = Schema.NonEmptyString.check(
  Schema.isMaxLength(12_000),
  Schema.isPattern(/\S/u),
)
export const ReportDreamRequest = Schema.Struct({ pass: DreamPass, finding: DreamFinding })
export type ReportDreamRequest = typeof ReportDreamRequest.Type
