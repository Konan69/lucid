import { describe, expect, it } from 'vitest'
import { whenIn } from './when.ts'

/** Wednesday 14 October 2026, mid-afternoon, on whatever clock the test machine keeps. */
const now = new Date(2026, 9, 14, 15, 0).getTime()

/**
 * A moment written as a date and time with no zone, which is read on the test machine's own
 * clock, so the calendar day is the one written here wherever the test runs.
 */
const at = (local: string) => new Date(local).getTime()

/**
 * What a locale's formatter says, with the narrow no-break space newer ICU data puts before
 * "AM" read as an ordinary one, so the expectation does not depend on the ICU version.
 */
const said = (locale: string, moment: number, from = now) =>
  whenIn(locale)(moment, from).replaceAll('\u202f', ' ')

describe('when a message was said', () => {
  it('is the time alone for anything said today', () => {
    expect(said('en-US', at('2026-10-14T09:41'))).toBe('9:41 AM')
    expect(said('en-US', at('2026-10-14T00:01'))).toBe('12:01 AM')
  })

  it('goes by the calendar day, not by how many hours ago it was', () => {
    // A minute before midnight is yesterday though it is fifteen hours old; yesterday morning is
    // still yesterday though it is more than a day old.
    expect(said('en-US', at('2026-10-13T23:59'))).toBe('Yesterday 11:59 PM')
    expect(said('en-US', at('2026-10-13T09:41'))).toBe('Yesterday 9:41 AM')
  })

  it('names the date, without the year, for anything earlier this year', () => {
    expect(said('en-US', at('2026-10-12T09:41'))).toBe('Oct 12, 9:41 AM')
    expect(said('en-US', at('2026-01-03T18:05'))).toBe('Jan 3, 6:05 PM')
  })

  it('adds the year once the message is from an earlier one', () => {
    expect(said('en-US', at('2025-10-03T09:41'))).toBe('Oct 3, 2025, 9:41 AM')
  })

  it('still says yesterday when yesterday was last year', () => {
    const newYear = at('2027-01-01T08:00')
    expect(said('en-US', at('2026-12-31T22:30'), newYear)).toBe('Yesterday 10:30 PM')
    expect(said('en-US', at('2026-12-30T22:30'), newYear)).toBe('Dec 30, 2026, 10:30 PM')
  })

  it('reads a message stamped ahead of this clock as a time alone, even past midnight', () => {
    expect(said('en-US', at('2026-10-14T15:02'))).toBe('3:02 PM')
    // A server clock a few minutes ahead, read just before midnight: the stamp is on tomorrow's
    // date, and next year's, and still gets no date and no year.
    expect(said('en-US', at('2026-10-15T00:05'), at('2026-10-14T23:58'))).toBe('12:05 AM')
    expect(said('en-US', at('2027-01-01T00:05'), at('2026-12-31T23:58'))).toBe('12:05 AM')
  })

  it('writes the date the way the locale does', () => {
    // The day leads and the clock has no AM. Whether the hour is padded differs between ICU
    // versions, so that one character is left open.
    expect(said('en-GB', at('2026-10-03T09:41'))).toMatch(/^3 Oct, 0?9:41$/u)
    expect(said('en-GB', at('2025-10-03T09:41'))).toMatch(/^3 Oct 2025, 0?9:41$/u)
  })
})
