/**
 * How far from the newest words, in points, the Person must be before they count as having
 * scrolled away. Under it they are still reading the foot of the conversation: the list keeps
 * following new words, and the button that brings them back stays folded away.
 */
export const AWAY = 120

/** Where a conversation's scroller is: how far down it is scrolled, and the two heights. */
export interface Scrolled {
  /** How far the content has been scrolled up past the top of the viewport, in points. */
  readonly offset: number
  /** The height of everything in the scroller. */
  readonly content: number
  /** The height of the part of it that is on screen. */
  readonly viewport: number
}

/**
 * Whether the Person has scrolled away from the newest words: more than `AWAY` of the
 * conversation is below the foot of the viewport.
 *
 * A conversation shorter than its viewport has nothing below the foot (the distance is negative),
 * and a scroller pulled past its end bounces the same way; neither is being away.
 */
export const isAway = ({ offset, content, viewport }: Scrolled): boolean =>
  content - offset - viewport > AWAY

/**
 * What the button that returns to the newest words says to a screen reader. It draws no number
 * (a dot stands for "something new"), so how many messages arrived is said here and only here.
 */
export const newestWords = (arrived: number): string => {
  if (arrived <= 0) return 'Go to the newest message'
  return arrived === 1
    ? 'Go to the newest message, 1 new message'
    : `Go to the newest message, ${arrived} new messages`
}
