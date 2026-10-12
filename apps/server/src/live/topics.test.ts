import { describe, expect, it } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { everyPart, type Reads, Topic, touches } from './changes.ts'

describe('narrowed topics', () => {
  const ada = PersonId.make('ada/with:odd#characters')
  const heard = (reads: Reads, moved: ReadonlyArray<string>) =>
    touches([Topic.person(ada)], reads)(moved)

  it('reaches every reader when a write names only the owner', () => {
    expect(heard([], [Topic.person(ada)])).toBe(true)
    expect(heard(['drafts'], [Topic.person(ada)])).toBe(true)
  })

  it('reaches only the readers of the part a write names', () => {
    const activity = Topic.part('activity')(Topic.person(ada))
    expect(heard(['activity'], [activity])).toBe(true)
    expect(heard(['notifications', 'drafts'], [activity])).toBe(false)
    expect(heard([], [activity])).toBe(false)
    expect(heard(everyPart, [activity])).toBe(true)
  })

  it('keeps another owner out, whatever the part, and lets a reconnect through', () => {
    const other = Topic.part('activity')(Topic.person(PersonId.make('grace')))
    expect(heard(everyPart, [other])).toBe(false)
    expect(heard([], ['*'])).toBe(true)
  })

  it('narrows a topic once and keeps the identifier whole', () => {
    const drafts = Topic.part('drafts')(Topic.person(ada))
    expect(drafts).toBe('p/drafts:ada/with:odd#characters')
    expect(Topic.part('activity')(drafts)).toBe(drafts)
  })
})
