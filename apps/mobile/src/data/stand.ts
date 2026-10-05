import type { Thread } from '@vivid/contracts'
import { Data } from 'effect'

/**
 * How Vivid stands at the top of a screen: what its capsule there shows (`ui/Presence.tsx`). One
 * of these, never a mix: there is no state in which the capsule says two things.
 */
export type Stand = Data.TaggedEnum<{
  /** Nothing to report: its face, in the mood of the moment, and its name. */
  Resting: { readonly mood: 'happy' | 'thinking' }
  /** At work on what this screen shows: the orb, and the word for it. */
  Thinking: {}
  /** Waiting for the Person to answer or to approve something. */
  Waiting: {}
  /** Someone else is writing in the Thread. `names` is who, and is never empty. */
  Typing: { readonly names: ReadonlyArray<string> }
}>
export const Stand = Data.taggedEnum<Stand>()

/** How Vivid stands in a Thread for each thing the Thread can be waiting on. */
const IN_THREAD = {
  Working: Stand.Thinking(),
  NeedsYou: Stand.Waiting(),
  Unread: Stand.Resting({ mood: 'happy' }),
  Quiet: Stand.Resting({ mood: 'happy' }),
} as const satisfies Record<Thread['attention'], Stand>

/**
 * How Vivid stands at the top of a Thread, given who else is writing in it.
 *
 * Work comes first. While Vivid is at work the capsule is the only thing on the screen that says
 * so (the transcript no longer does), so someone else's typing does not take its place. When
 * Vivid is not at work, someone writing is the thing about to change the Thread, and is said
 * instead of whatever the Thread was waiting on.
 */
export const standIn = (attention: Thread['attention'], writing: ReadonlyArray<string>): Stand => {
  if (attention === 'Working' || writing.length === 0) return IN_THREAD[attention]
  return Stand.Typing({ names: writing })
}
