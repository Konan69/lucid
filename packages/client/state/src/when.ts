/**
 * A moment, said the way a person would say it today.
 *
 * A bare clock under a message is only true on the day it was written: "9:41 AM" on a message
 * from last Tuesday reads as this morning. A moment is said against the reader's own calendar
 * instead: today is just the time, yesterday says so, earlier this year carries its date, and an
 * earlier year carries the year. Days are calendar days where the reader is, not spans of
 * twenty-four hours, so a message from 11 PM last night is "yesterday" at 1 AM.
 */

/** Where and in what language a moment is read: an IANA zone and a locale. */
export interface Reader {
  readonly locale: string
  readonly timeZone: string
}

/** The reader this device is set to. */
export const thisReader = (): Reader => {
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions()
  return { locale, timeZone }
}

/** The calendar day a moment falls on for a reader, as a count of days, so two can be compared. */
const dayOf = (moment: number, reader: Reader) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: reader.timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(moment)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.filter((part) => part.type === type).map((part) => part.value)[0])
  return {
    year: read('year'),
    day: Date.UTC(read('year'), read('month') - 1, read('day')) / 86_400_000,
  }
}

const capitalised = (words: string, locale: string) =>
  words.slice(0, 1).toLocaleUpperCase(locale) + words.slice(1)

/**
 * Makes the sayer for one reader. The formatters are built once: this is called for every
 * message on screen, and building an `Intl` formatter is the expensive part.
 */
export function makeWhen(reader: Reader) {
  const zone = { timeZone: reader.timeZone }
  const time = new Intl.DateTimeFormat(reader.locale, {
    ...zone,
    hour: 'numeric',
    minute: '2-digit',
  })
  const dated = new Intl.DateTimeFormat(reader.locale, {
    ...zone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  const yeared = new Intl.DateTimeFormat(reader.locale, {
    ...zone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const yesterday = capitalised(
    new Intl.RelativeTimeFormat(reader.locale, { numeric: 'auto' }).format(-1, 'day'),
    reader.locale,
  )
  /** `moment` as it reads at `now`. Both are epoch milliseconds. */
  return (moment: number, now: number): string => {
    const then = dayOf(moment, reader)
    const today = dayOf(now, reader)
    if (then.day === today.day) return time.format(moment)
    if (then.day === today.day - 1) return `${yesterday} ${time.format(moment)}`
    return then.year === today.year ? dated.format(moment) : yeared.format(moment)
  }
}

/** The whole date and time, for a tooltip: nothing left to work out. */
export function makeFullWhen(reader: Reader) {
  const full = new Intl.DateTimeFormat(reader.locale, {
    timeZone: reader.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  })
  return (moment: number): string => full.format(moment)
}

/**
 * How Vivid greets a Person at an hour of their own day (0 to 23, on the clock they keep): the
 * word the first screen opens with, before their name. The day is cut where a person would cut
 * it, not at midnight: someone writing at two in the morning has not started tomorrow.
 */
export const greetingAt = (hour: number): string => {
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Morning'
  if (hour < 18) return 'Afternoon'
  return 'Evening'
}
