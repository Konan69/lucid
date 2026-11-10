import { Option } from 'effect'
import type { Anchor } from '../../data/reading'

/**
 * How far from the newest words, in points, the Person must be before they count as having
 * scrolled away. Under it they are still reading the foot of the conversation: the list keeps
 * following new words, and the button that brings them back stays folded away.
 */
const AWAY = 120

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
 * Whether Vivid's reply is coming in now: Vivid is working and the newest message is its own.
 * While it is, the conversation does not follow the new words down. The owner asked for that on
 * 26 October 2026 ("during inference the view shouldn't auto-scroll", kept by Vivid in its notes
 * of his bug reports): the list stays where the Person is reading, and once the reply runs past
 * the foot of the screen the button that goes to the newest words comes out.
 */
export const replying = (
  working: boolean,
  messages: ReadonlyArray<{ readonly role: string }>,
): boolean =>
  working && Option.exists(Option.fromUndefinedOr(messages.at(-1)), (m) => m.role === 'assistant')

/** How many messages arrived after the newest one the Person had seen, when they are away. */
export const arrivedOf = (
  awayAt: Option.Option<string>,
  messages: ReadonlyArray<{ readonly id: string }>,
): number =>
  Option.match(awayAt, { onNone: () => 0, onSome: (newest) => arrivedSince(messages, newest) })

/** The newest message's id: what the Person had seen when they scrolled away. */
export const newestOf = (messages: ReadonlyArray<{ readonly id: string }>): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(messages.at(-1)), (message) => message.id)

/**
 * How many messages arrived after `newest`, the newest the Person had seen. Counted from that
 * message and not from how many there were, because older history loading in above is not
 * arriving. A message that is no longer there has nothing after it to count.
 */
const arrivedSince = (messages: ReadonlyArray<{ readonly id: string }>, newest: string): number => {
  const at = messages.findIndex((message) => message.id === newest)
  return at === -1 ? 0 : messages.length - 1 - at
}

/** Where a scroller is, from what its scroll event reports. */
export const scrolledOf = (event: {
  readonly contentOffset: { readonly y: number }
  readonly contentSize: { readonly height: number }
  readonly layoutMeasurement: { readonly height: number }
}): Scrolled => ({
  offset: event.contentOffset.y,
  content: event.contentSize.height,
  viewport: event.layoutMeasurement.height,
})

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

/** Where a row of the conversation is laid out, from the top of everything said, in points. */
export interface Laid {
  readonly y: number
  readonly height: number
}

/**
 * The place a Person is reading (`data/reading.ts`): the first row whose foot is below `top`, the
 * top of the viewport measured from the top of everything said, and how far into it `top` is.
 * Places are kept by message rows only, so when the viewport starts in something after the last
 * of them (an answer's card at the end), the place is the last message row above it, with an
 * offset past its foot.
 */
export const anchorAt = (rows: ReadonlyMap<string, Laid>, top: number): Option.Option<Anchor> => {
  const sorted = [...rows].sort(([, a], [, b]) => a.y - b.y)
  return Option.map(
    Option.orElse(Option.fromUndefinedOr(sorted.find(([, row]) => row.y + row.height > top)), () =>
      Option.fromUndefinedOr(sorted.filter(([, row]) => row.y <= top).at(-1)),
    ),
    ([key, row]) => ({ key, offset: top - row.y }),
  )
}

/**
 * Where the top of the viewport goes to show `anchor` again, from the top of everything said; none
 * while its row is not laid out. Rows added above move the row and so the answer with it; rows
 * added below do not.
 */
export const offsetFor = (anchor: Anchor, rows: ReadonlyMap<string, Laid>): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(rows.get(anchor.key)), (row) => row.y + anchor.offset)
