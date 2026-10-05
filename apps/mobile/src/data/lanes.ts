import type { Thread } from '@vivid/contracts'
import { Data, Option } from 'effect'

/**
 * The Thread list, arranged the way a busy Person should look at it: what is waiting on them,
 * what Vivid is working on, then everything else by the day it last moved. The same order as the
 * web sidebar (`apps/web/src/screen/Sidebar.tsx`), as pure functions over what the server sends.
 *
 * A Thread moves between lanes because the server says its attention changed. Nothing here
 * remembers where a Thread was.
 */

const DAY = 86_400_000

/** Midnight at the start of the day a moment falls in, in the Person's own clock. */
const startOfDay = (moment: number): number => {
  const date = new Date(moment)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whole calendar days between two moments. Rounded, so a daylight-saving day still counts as one. */
const daysBetween = (earlier: number, later: number): number =>
  Math.round((startOfDay(later) - startOfDay(earlier)) / DAY)

/** The quiet bands, in the order they are drawn. */
export const BANDS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const
export type Band = (typeof BANDS)[number]

/** Which quiet band a Thread belongs in, by when it last moved. */
export const bandOf = (updatedAt: number, now: number): Band => {
  const days = daysBetween(updatedAt, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return days < 7 ? 'This week' : 'Earlier'
}

/** When a Thread last moved, as briefly as its age allows: a time today, a weekday, then a date. */
export const relativeTime = (updatedAt: number, now: number): string => {
  const days = daysBetween(updatedAt, now)
  if (days <= 0) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
      updatedAt,
    )
  }
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(updatedAt)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(updatedAt)
}

/**
 * One group of Threads under a heading. Every Thread in it is one line, its title: the heading
 * already says what the lane is, so a row does not say it again, and the drawer is where a
 * Thread is found, not where it is read. Only the attention lanes say how many they hold.
 */
export interface Lane {
  readonly label: 'Needs you' | 'Working' | Band
  readonly counted: boolean
  readonly threads: ReadonlyArray<Thread>
}

export interface Arrangement {
  /** The lanes that hold something, in the order they are drawn. An empty lane is not a lane. */
  readonly lanes: ReadonlyArray<Lane>
  /** Archived Threads, kept apart under their own disclosure. */
  readonly archived: ReadonlyArray<Thread>
}

/** Arranges every Thread the Person can see. Within a lane the server's own order is kept. */
export function arrange(threads: ReadonlyArray<Thread>, now: number): Arrangement {
  const current = threads.filter((thread) => !thread.archived)
  const quiet = current.filter(
    (thread) => thread.attention !== 'NeedsYou' && thread.attention !== 'Working',
  )
  const lanes: ReadonlyArray<Lane> = [
    {
      label: 'Needs you',
      counted: true,
      threads: current.filter((thread) => thread.attention === 'NeedsYou'),
    },
    {
      label: 'Working',
      counted: true,
      threads: current.filter((thread) => thread.attention === 'Working'),
    },
    ...BANDS.map((band): Lane => ({
      label: band,
      counted: false,
      threads: quiet.filter((thread) => bandOf(thread.updatedAt, now) === band),
    })),
  ]
  return {
    lanes: lanes.filter((lane) => lane.threads.length > 0),
    archived: threads.filter((thread) => thread.archived),
  }
}

/** The Threads whose title or last words contain what was typed, whatever its case. */
export const matching = (threads: ReadonlyArray<Thread>, query: string): ReadonlyArray<Thread> => {
  const wanted = query.trim().toLocaleLowerCase()
  if (wanted === '') return threads
  return threads.filter((thread) =>
    `${thread.title} ${thread.preview}`.toLocaleLowerCase().includes(wanted),
  )
}

/** One row of the list: a lane's heading, which says whether the lane is folded, or a Thread. */
export type Row = Data.TaggedEnum<{
  Heading: {
    readonly label: Lane['label']
    readonly count: Option.Option<number>
    readonly folded: boolean
  }
  Entry: { readonly thread: Thread }
}>
export const Row = Data.taggedEnum<Row>()

/**
 * The lanes as the flat list a native list view scrolls: each heading, then its Threads. A lane
 * the Person folded keeps its heading, which is what unfolds it, and lists none of its Threads.
 */
export const rowsOf = (
  lanes: ReadonlyArray<Lane>,
  folded: ReadonlySet<Lane['label']>,
): ReadonlyArray<Row> =>
  lanes.flatMap((lane) => {
    const shut = folded.has(lane.label)
    return [
      Row.Heading({
        label: lane.label,
        count: lane.counted ? Option.some(lane.threads.length) : Option.none(),
        folded: shut,
      }),
      ...(shut ? [] : lane.threads.map((thread) => Row.Entry({ thread }))),
    ]
  })

/** A row's key. Headings are named for their lane, which appears at most once. */
export const rowKey = (row: Row): string =>
  Row.$match(row, {
    Heading: ({ label }) => `lane:${label}`,
    Entry: ({ thread }) => thread.id,
  })
