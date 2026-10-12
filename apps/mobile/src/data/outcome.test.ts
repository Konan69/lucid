import { PersonId, RunId, RunOrigin, RunState, ThreadId, type Run } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { endingOf, newestRun } from './outcome.ts'

const ada = { id: PersonId.make('ada'), name: 'Ada Obi', image: null }

/** A Run with its place in the Thread and the moment it started said apart. */
const startedAt = (turn: number, moment: number, state: RunState): Run => ({
  id: RunId.make(`submission-${turn}`),
  threadId: ThreadId.make('thread'),
  turn,
  origin: RunOrigin.cases.Message.make({ person: ada }),
  state,
  startedAt: moment,
})

/** A Run that started in the order of its turn, as most do. */
const run = (turn: number, state: RunState): Run => startedAt(turn, turn, state)

describe('how a Run ended', () => {
  it('says nothing about a Run that answered, was stopped, or is still going', () => {
    for (const state of [
      RunState.cases.Working.make({}),
      RunState.cases.Completed.make({ finishedAt: 2 }),
      RunState.cases.Stopped.make({ finishedAt: 2 }),
    ]) {
      expect(Option.isNone(endingOf(run(1, state)))).toBe(true)
    }
  })

  it('says a message that never started a Run should be sent again', () => {
    const failed = run(1, RunState.cases.Failed.make({ finishedAt: 2, reason: 'Delivery' }))
    expect(endingOf(failed)).toEqual(
      Option.some({ words: 'Vivid could not start on that. Send it again.', again: true }),
    )
  })

  it('offers nothing to press when asking again cannot help', () => {
    const failed = run(1, RunState.cases.Failed.make({ finishedAt: 2, reason: 'ModelUnavailable' }))
    expect(Option.map(endingOf(failed), (ending) => ending.again)).toEqual(Option.some(false))
  })

  it('admits it when the outcome of a Run cannot be told', () => {
    const lost = run(1, RunState.cases.Unknown.make({ finishedAt: 2 }))
    // The words must not say it finished or that it failed: neither is known.
    expect(endingOf(lost)).toEqual(
      Option.some({
        words: 'Vivid lost track of this one, so it may not have finished.',
        again: true,
      }),
    )
  })

  it('goes by the Run that started last, whatever order they arrive in', () => {
    const older = run(1, RunState.cases.Failed.make({ finishedAt: 2, reason: 'TimedOut' }))
    const newer = run(2, RunState.cases.Completed.make({ finishedAt: 3 }))
    expect(newestRun([newer, older])).toEqual(Option.some(newer))
    expect(newestRun([older, newer])).toEqual(Option.some(newer))
    // The start time decides, not the turn number and not the position: a Run with a lower turn
    // that started later is the newest.
    const restarted = startedAt(1, 9, RunState.cases.Working.make({}))
    expect(newestRun([restarted, newer])).toEqual(Option.some(restarted))
    expect(newestRun([newer, restarted])).toEqual(Option.some(restarted))
    expect(newestRun([])).toEqual(Option.none())
  })
})
