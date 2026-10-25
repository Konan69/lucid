import { Option } from 'effect'

/**
 * One clock for the whole page that ticks once a second, only while something on screen is
 * reading it: the first reader starts it and the last one to leave stops it. A count that has to
 * move ("Working · 12s") reads it instead of keeping a timer of its own, so two counts on screen
 * tick together and nothing ticks when no count is shown.
 */
const readers = new Set<() => void>()
let timer: Option.Option<ReturnType<typeof setInterval>> = Option.none()
let now = Date.now()

const tick = () => {
  now = Date.now()
  for (const reader of readers) reader()
}

const watch = (reader: () => void) => {
  readers.add(reader)
  if (Option.isNone(timer)) {
    // A reader arriving after a pause would otherwise see the time the clock last stopped at.
    now = Date.now()
    timer = Option.some(setInterval(tick, 1000))
  }
  return () => {
    readers.delete(reader)
    if (readers.size === 0 && Option.isSome(timer)) {
      clearInterval(timer.value)
      timer = Option.none()
    }
  }
}

const read = () => now

/**
 * The page's second clock as an external store (`useSyncExternalStore(clock.watch, clock.read)`
 * on web and phone): `watch` starts it for a reader and returns how to leave, `read` is the time.
 */
export const clock = { watch, read }

/** A span of time as Vivid says it beside work: "8s", "1m 4s", "12m". */
export const spanOf = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const left = seconds % 60
  return left === 0 ? `${minutes}m` : `${minutes}m ${left}s`
}
