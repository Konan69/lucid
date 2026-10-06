import type { Thread } from '@vivid/contracts'
import { Data } from 'effect'

/**
 * How Vivid stands at the top of a screen: what its capsule there shows (`ui/Presence.tsx`). One
 * of these, never a mix: there is no state in which the capsule says two things.
 *
 * That Vivid is at work is not one of them. It is said at the foot of the conversation, just
 * above the composer (`ui/Thinking.tsx`), which is where the owner asked for it after seeing it
 * at the top of his phone (6 October 2026); up here work only changes the mood of Vivid's face.
 */
export type Stand = Data.TaggedEnum<{
  /** Nothing is asked of the Person: Vivid's face, in the mood of the moment, and its name. */
  Resting: { readonly mood: 'happy' | 'thinking' }
  /** Waiting for the Person to answer or to approve something. */
  Waiting: {}
  /** Someone else is writing in the Thread. `names` is who, and is never empty. */
  Typing: { readonly names: ReadonlyArray<string> }
}>
export const Stand = Data.taggedEnum<Stand>()

/** How Vivid stands in a Thread for each thing the Thread can be waiting on. */
const IN_THREAD = {
  Working: Stand.Resting({ mood: 'thinking' }),
  NeedsYou: Stand.Waiting(),
  Unread: Stand.Resting({ mood: 'happy' }),
  Quiet: Stand.Resting({ mood: 'happy' }),
} as const satisfies Record<Thread['attention'], Stand>

/**
 * How Vivid stands at the top of a Thread, given who else is writing in it. Someone writing is
 * the thing about to change the Thread, so it is said instead of whatever the Thread was waiting
 * on. It may be said while Vivid works too: the work has its own place on the screen.
 */
export const standIn = (attention: Thread['attention'], writing: ReadonlyArray<string>): Stand =>
  writing.length === 0 ? IN_THREAD[attention] : Stand.Typing({ names: writing })
