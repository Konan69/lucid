/**
 * When a message was said, as briefly as its age allows: the time alone today, the day before it
 * named, then a date, and the year only once it is no longer this one. A bare clock on a message
 * from last week reads as if it were said this morning.
 *
 * The day is the calendar's, in the clock the phone keeps: a message from 11 PM is yesterday's at
 * 1 AM, though it is two hours old. "Now" is handed in, so the same message always reads the same
 * on one screen and the rule can be tested without waiting for midnight.
 */

/** Midnight at the start of the day a moment falls in, on the device's clock. */
const startOfDay = (moment: number): number => {
  const date = new Date(moment)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const sameYear = (one: number, other: number): boolean =>
  new Date(one).getFullYear() === new Date(other).getFullYear()

/**
 * The formatter for one locale. The three `Intl` formatters are built once and reused, because a
 * Thread formats a time for every message it draws and building one is the slow part.
 *
 * The order and punctuation of a date are the locale's ("3 Oct, 9:41 AM" in one, "Oct 3, 9:41 AM"
 * in another). "Yesterday" is the app's own word, like the rest of its copy: the phone's engine
 * (Hermes) has no `Intl.RelativeTimeFormat` to ask for the locale's.
 */
export const whenIn = (locale: Intl.LocalesArgument) => {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  const year = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return (moment: number, now: number): string => {
    const today = startOfDay(now)
    // A message stamped a little ahead of this phone's clock was still said today.
    if (moment >= today) return time.format(moment)
    // Yesterday's midnight is found on the calendar, not by taking 24 hours off: a day on which
    // the clocks change is 23 or 25 hours long.
    if (moment >= startOfDay(today - 1)) return `Yesterday ${time.format(moment)}`
    return sameYear(moment, now) ? day.format(moment) : year.format(moment)
  }
}

/** When a message was said, written the way this device writes dates and times. */
export const when = whenIn(undefined)
