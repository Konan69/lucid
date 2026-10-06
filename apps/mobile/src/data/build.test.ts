import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { Running, runningFrom, runningWords, type Reported } from './build'

const published = new Date('2026-10-06T08:12:00.000Z')
const id = '3f2a9c1e-7b64-4d0a-9c55-0f6a1d2e3b4c'
const delivered: Reported = {
  enabled: true,
  embedded: false,
  published: Option.some(published),
  id: Option.some(id),
}
const write = (moment: Date) => moment.toISOString()

describe('what this phone is running', () => {
  it('is the delivered update, named by when it was published and its id', () => {
    expect(runningFrom(delivered)).toEqual(Running.Updated({ published, id }))
    expect(runningWords(runningFrom(delivered), write)).toBe(
      'Published 2026-10-06T08:12:00.000Z · 3f2a9c1e',
    )
  })

  it('is the installed app while the launch is the copy inside it, though that has a date too', () => {
    expect(runningFrom({ ...delivered, embedded: true })).toEqual(Running.Installed())
  })

  it('is nothing to wait for in a build that takes no updates', () => {
    expect(runningFrom({ ...delivered, enabled: false })).toEqual(Running.Off())
  })

  it('does not invent a date for an update the client could not name', () => {
    expect(runningFrom({ ...delivered, published: Option.none() })).toEqual(Running.Unnamed())
  })
})
