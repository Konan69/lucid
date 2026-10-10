import { ComputerId, ComputerScreen, ComputerState, type Computer } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { screenNote, standingOf, viewerOf, viewerOnGlass } from './computer.ts'

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

describe('where a phone can watch the screen', () => {
  const viewer = ComputerState.cases.Running.make({
    since: 1,
    screen: ComputerScreen.cases.Viewer.make({
      address: 'https://viewer.example/stream.html#permission',
      expiresAt: 2,
    }),
  })

  it('is the provider’s viewer page, whole, with the permission in its fragment', () => {
    expect(viewerOf(computer(viewer))).toEqual(
      Option.some('https://viewer.example/stream.html#permission'),
    )
  })

  it('is nowhere for a relayed screen or a computer that is off', () => {
    expect(viewerOf(computer(running))).toEqual(Option.none())
    expect(viewerOf(computer(ComputerState.cases.Stopped.make({ since: 1 })))).toEqual(
      Option.none(),
    )
  })

  it('warns that a touch reaches the machine only while Vivid has the keyboard', () => {
    expect(screenNote(computer(viewer))).toContain('take over first')
    expect(screenNote(computer(viewer, true))).toBe('Its screen opens in your browser.')
    // No page to open: the note sends the Person to a browser and promises nothing here.
    expect(screenNote(computer(running))).toContain('not shown on the phone')
  })
})

describe('the viewer address the glass loads', () => {
  it('drops the light theme wherever it stands and keeps everything else, the permission too', () => {
    expect(viewerOnGlass('https://v.example/stream.html?appId=1&theme=light&width=1920#k=s')).toBe(
      'https://v.example/stream.html?appId=1&width=1920#k=s',
    )
    expect(viewerOnGlass('https://v.example/stream.html?theme=light&width=1920#k=s')).toBe(
      'https://v.example/stream.html?width=1920#k=s',
    )
    expect(viewerOnGlass('https://v.example/stream.html?width=1920&theme=light#k=s')).toBe(
      'https://v.example/stream.html?width=1920#k=s',
    )
    expect(viewerOnGlass('https://v.example/stream.html?theme=light#k=s')).toBe(
      'https://v.example/stream.html#k=s',
    )
  })

  it('leaves an address with no theme as it came', () => {
    expect(viewerOnGlass('https://v.example/stream.html?width=1920#theme=light')).toBe(
      'https://v.example/stream.html?width=1920#theme=light',
    )
  })
})
