import { expect, it } from 'vitest'
import { Stand, standIn } from './stand.ts'

it('thinks while Vivid is at work, whoever else is writing', () => {
  expect(standIn('Working', [])).toEqual(Stand.Thinking())
  // The capsule is the only place that says Vivid is working; typing must not hide it.
  expect(standIn('Working', ['Ada'])).toEqual(Stand.Thinking())
})

it('says who is writing when Vivid is not at work', () => {
  expect(standIn('Quiet', ['Ada', 'Grace'])).toEqual(Stand.Typing({ names: ['Ada', 'Grace'] }))
  // Someone writing is what is about to change the Thread, more than what it was waiting on.
  expect(standIn('NeedsYou', ['Ada'])).toEqual(Stand.Typing({ names: ['Ada'] }))
})

it('waits for the Person when the Thread needs them and nobody is writing', () => {
  expect(standIn('NeedsYou', [])).toEqual(Stand.Waiting())
})

it('rests under its own name otherwise, read or unread', () => {
  expect(standIn('Quiet', [])).toEqual(Stand.Resting({ mood: 'happy' }))
  expect(standIn('Unread', [])).toEqual(Stand.Resting({ mood: 'happy' }))
})
