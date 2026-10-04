import { OpenFirstThreadResult, ThreadId } from '@vivid/contracts'
import { LiveState } from '@vivid/state'
import { Option } from 'effect'
import { expect, it } from 'vitest'
import { Arrival, destination, homeShows, shouldAsk, Showing } from './arrival.ts'

const first = ThreadId.make('thread-first')
const empty = LiveState.Ready({ value: { threads: [] } })
const one = LiveState.Ready({ value: { threads: [{ id: first }] } })
const loading = LiveState.Loading()

it('asks only once, for an empty list, while the Person is on Home', () => {
  expect(shouldAsk(Arrival.Unasked(), empty, true)).toBe(true)
  // Someone on another screen is not taken away from it.
  expect(shouldAsk(Arrival.Unasked(), empty, false)).toBe(false)
  expect(shouldAsk(Arrival.Unasked(), loading, true)).toBe(false)
  expect(shouldAsk(Arrival.Unasked(), one, true)).toBe(false)
  expect(shouldAsk(Arrival.Asking(), empty, true)).toBe(false)
  expect(shouldAsk(Arrival.Settled(), empty, true)).toBe(false)
})

it('goes to the Thread the server opened', () => {
  const opened = OpenFirstThreadResult.cases.Opened.make({ thread: first })
  expect(destination(opened, () => false)).toEqual(Option.some(first))
})

it('goes to an existing first Thread only when this workspace lists it', () => {
  const existing = OpenFirstThreadResult.cases.Existing.make({ thread: first })
  expect(destination(existing, () => true)).toEqual(Option.some(first))
  expect(destination(existing, () => false)).toEqual(Option.none())
})

it('stays on Home when this is not a first arrival', () => {
  const not = OpenFirstThreadResult.cases.NotFirst.make({})
  expect(destination(not, () => true)).toEqual(Option.none())
})

it('draws nothing on Home until the list says which Home this Person gets', () => {
  expect(homeShows(Arrival.Unasked(), loading)).toEqual(Showing.Nothing())
  expect(homeShows(Arrival.Unasked(), one)).toEqual(Showing.Ordinary())
  expect(homeShows(Arrival.Unasked(), empty)).toEqual(Showing.Waiting())
})

it('keeps the face while asking, even once the new Thread is in the list', () => {
  expect(homeShows(Arrival.Asking(), empty)).toEqual(Showing.Waiting())
  expect(homeShows(Arrival.Asking(), one)).toEqual(Showing.Waiting())
})

it('is the ordinary Home once settled, with or without a Thread', () => {
  expect(homeShows(Arrival.Settled(), empty)).toEqual(Showing.Ordinary())
  expect(homeShows(Arrival.Settled(), loading)).toEqual(Showing.Ordinary())
})
