import type { ThreadId } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * A place in a conversation: the message row at the top of the viewport (`key`, the row's key in
 * the list) and how far down into that row the viewport starts, in points.
 */
export interface Anchor {
  readonly key: string
  readonly offset: number
}

/**
 * Where the Person was reading in each Thread they scrolled up in and left.
 *
 * A Thread's list is made again each time the Thread is opened, and it used to open on the newest
 * words every time: leaving a Thread to look at another and coming back lost the place the Person
 * was reading. The place is kept as the row they were reading (`Anchor`), not as a distance from
 * either end of the list: what a Thread is drawn from first (`data/hearing.ts`, its newest
 * messages) is shorter than its whole history, which arrives a moment later and grows the list
 * above, and a reply that arrives while the Person is away grows it below. Neither moves a row
 * against the words in it.
 *
 * It is kept for as long as the app runs, beside the conversations themselves. A Thread the
 * Person left at its newest words has nothing kept, and opens there.
 */
const read = new Map<ThreadId, Anchor>()

export const readingPlace = {
  /** Where the Person was reading in a Thread, when they had scrolled away from its newest words. */
  of: (id: ThreadId): Option.Option<Anchor> => Option.fromUndefinedOr(read.get(id)),
  /** The Person is reading at `anchor`. */
  keep: (id: ThreadId, anchor: Anchor): void => {
    read.set(id, anchor)
  },
  /** The Person is at the newest words. */
  drop: (id: ThreadId): void => {
    read.delete(id)
  },
}
