import { ComputerId, ComputerScreen, ComputerState, type Computer } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { standingOf } from './computer.ts'

const computer = (state: ComputerState, heldByPerson = false): Computer => ({
  id: ComputerId.make('computer'),
  state,
  heldByPerson,
})

const running = ComputerState.cases.Running.make({
  since: 1,
  screen: ComputerScreen.cases.Relay.make({ address: '/api/computer/screen' }),
})

describe('where Vivid’s computer stands, in words', () => {
  it('says who has the keyboard while it runs, and never that the phone is watching', () => {
    const vivids = standingOf(computer(running))
    const mine = standingOf(computer(running, true))
    expect([vivids.glass, mine.glass]).toEqual(['Vivid has the keyboard', 'You have the keyboard'])
    // A running computer is not started again; it is taken over or turned off.
    expect([vivids.start, mine.start]).toEqual([Option.none(), Option.none()])
  })

  it('gives a start that failed the machine’s own reason and a way to try again', () => {
    const failed = standingOf(
      computer(
        ComputerState.cases.Failed.make({ since: 1, reason: 'The image could not be pulled.' }),
      ),
    )
    expect(failed.detail).toBe('The image could not be pulled.')
    expect(failed.start).toEqual(Option.some('Try again'))
  })

  it('offers turning it on only where that can work', () => {
    const offered = (state: ComputerState) => standingOf(computer(state)).start
    expect(offered(ComputerState.cases.Absent.make({}))).toEqual(Option.some('Turn it on'))
    expect(offered(ComputerState.cases.Stopped.make({ since: 1 }))).toEqual(
      Option.some('Turn it on'),
    )
    // Already on its way: nothing to press.
    expect(offered(ComputerState.cases.Starting.make({ since: 1 }))).toEqual(Option.none())
  })
})
