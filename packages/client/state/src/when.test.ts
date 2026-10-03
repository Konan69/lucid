import { describe, expect, it } from 'vitest'
import { greetingAt, makeWhen } from './when.js'

const when = makeWhen({ locale: 'en-GB', timeZone: 'Africa/Lagos' })

/** A moment in Lagos (UTC+1, no daylight saving), written as its local date and wall clock. */
const at = (local: string) => Date.parse(`${local}:00+01:00`)

describe('when a message was written, as read today', () => {
  const now = at('2026-10-02T01:05')

  it('is only the time on the same day', () => {
    expect(when(at('2026-10-02T00:30'), now)).toBe('0:30')
  })

  it('is yesterday by the calendar, not by twenty-four hours', () => {
    // Two hours ago, but before midnight where the reader is.
    expect(when(at('2026-10-01T23:10'), now)).toBe('Yesterday 23:10')
  })

  it('carries its date earlier in the year and its year before that', () => {
    expect(when(at('2026-09-30T09:41'), now)).toBe('30 Sept, 9:41')
    expect(when(at('2025-10-03T09:41'), now)).toBe('3 Oct 2025, 9:41')
  })

  it('reads the same moment by the reader’s own zone', () => {
    const tokyo = makeWhen({ locale: 'en-GB', timeZone: 'Asia/Tokyo' })
    // 23:10 on the 1st in Lagos is already 07:10 on the 2nd in Tokyo: today there.
    expect(tokyo(at('2026-10-01T23:10'), now)).toBe('7:10')
  })
})

describe('the greeting for an hour of the day', () => {
  it('changes where a person would say the day changes, not at midnight', () => {
    expect([0, 4].map((hour) => greetingAt(hour))).toEqual(['Still up', 'Still up'])
    expect([5, 11].map((hour) => greetingAt(hour))).toEqual(['Morning', 'Morning'])
    expect([12, 17].map((hour) => greetingAt(hour))).toEqual(['Afternoon', 'Afternoon'])
    expect([18, 23].map((hour) => greetingAt(hour))).toEqual(['Evening', 'Evening'])
  })
})
