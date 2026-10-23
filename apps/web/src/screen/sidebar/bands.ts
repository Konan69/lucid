import { Option } from 'effect'
import { create } from 'zustand'
import { kept } from '../../data/kept'

/**
 * The quiet bands the Thread list is cut into by day, and which of them the Person has folded
 * away.
 */

const DAY = 86_400_000

/** Midnight at the start of the day a moment falls in, in the Person's own clock. */
const startOfDay = (moment: number) => {
  const date = new Date(moment)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** How many midnights lie between a moment and now. */
export const daysAgo = (updatedAt: number, now: number) =>
  Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY)

export const BANDS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const
export type Band = (typeof BANDS)[number]

/** Which band a Thread belongs in, by when it last moved. */
export function band(updatedAt: number, now: number): Band {
  const days = daysAgo(updatedAt, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return days < 7 ? 'This week' : 'Earlier'
}

// Which bands are folded is the Person's choice on this browser, like the Projects group above
// the list (`Projects.tsx`). It is a Zustand store for the same reason: the choice is read once,
// when the store is made, and written when it is changed, so no caption needs an effect. What is
// kept is the folded bands' names with a line break between them; a name that is not a band (an
// older build's, a hand-edited one) is simply not found below.
const key = 'vivid.threads.folded'

const useFolded = create<{ readonly folded: ReadonlySet<Band> }>()(() => {
  const names = Option.match(kept.read(key), {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (text) => text.split('\n'),
  })
  return { folded: new Set(BANDS.filter((name) => names.includes(name))) }
})

/** Whether one band is folded. A caption that reads it re-renders only when its own answer changes. */
export const useBandFolded = (name: Band) => useFolded((state) => state.folded.has(name))

/** Folds a band that is open and opens one that is folded, and remembers which are folded. */
export function toggleBand(name: Band) {
  const { folded } = useFolded.getState()
  const next = new Set(BANDS.filter((other) => folded.has(other) !== (other === name)))
  useFolded.setState({ folded: next })
  kept.write(key, [...next].join('\n'))
}
