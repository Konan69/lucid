import { expect, it } from 'vitest'
import { Stand, standIn } from './stand.ts'

it('only changes the mood of its face while Vivid is at work', () => {
  // The work itself is said just above the composer, not in the capsule.
  expect(standIn('Working', [])).toEqual(Stand.Resting({ mood: 'thinking' }))
})

it('says who is writing, whatever the Thread was waiting on', () => {
  expect(standIn('Quiet', ['Ada', 'Grace'])).toEqual(Stand.Typing({ names: ['Ada', 'Grace'] }))
  expect(standIn('NeedsYou', ['Ada'])).toEqual(Stand.Typing({ names: ['Ada'] }))
  expect(standIn('Working', ['Ada'])).toEqual(Stand.Typing({ names: ['Ada'] }))
})

it('waits for the Person when the Thread needs them and nobody is writing', () => {
  expect(standIn('NeedsYou', [])).toEqual(Stand.Waiting())
})

it('rests under its own name otherwise, read or unread', () => {
  expect(standIn('Quiet', [])).toEqual(Stand.Resting({ mood: 'happy' }))
  expect(standIn('Unread', [])).toEqual(Stand.Resting({ mood: 'happy' }))
})
