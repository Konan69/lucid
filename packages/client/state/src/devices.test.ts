import { DeviceAccess, DeviceId, DevicePresence, type Device } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { allowing, deviceAnswers, deviceAsked, stopping } from './devices.js'

const listening = DevicePresence.cases.Connected.make({ ability: { pages: true, apps: true } })
const offline = DevicePresence.cases.Offline.make({})
const pending = DeviceAccess.cases.Pending.make({ since: 1 })
const allowedAccess = DeviceAccess.cases.Allowed.make({ since: 1 })
const revoked = DeviceAccess.cases.Revoked.make({ since: 1 })

const device = (n: number, access: DeviceAccess, presence: DevicePresence): Device => ({
  id: DeviceId.make(`00000000-0000-4000-8000-00000000000${n}`),
  name: `Computer ${n}`,
  access,
  presence,
})

/** The name of the computer asked about, when the computers at `asking` (counted from 1) ask. */
const askedName = (devices: ReadonlyArray<Device>, asking: ReadonlyArray<number>) =>
  Option.map(
    deviceAsked({
      devices,
      asking: devices.flatMap((each, place) => (asking.includes(place + 1) ? [each.id] : [])),
    }),
    (asked) => asked.device.name,
  )

describe('which computer is asked about over the composer', () => {
  it('asks about a waiting computer whose desktop app is asking now', () => {
    expect(askedName([device(1, pending, offline)], [1])).toEqual(Option.some('Computer 1'))
  })

  it('does not ask about a row whose app is not asking, or one already answered no', () => {
    expect(askedName([device(1, pending, offline), device(2, revoked, offline)], [2])).toEqual(
      Option.none(),
    )
  })

  it('does not ask while an allowed computer is listening', () => {
    expect(
      askedName([device(1, allowedAccess, listening), device(2, pending, offline)], [2]),
    ).toEqual(Option.none())
  })

  it('asks when the allowed computer is offline, and says it would stop being used', () => {
    const waiting = device(2, pending, offline)
    const asked = deviceAsked({
      devices: [device(1, allowedAccess, offline), waiting],
      asking: [waiting.id],
    })
    expect(Option.map(asked, (each) => each.device.name)).toEqual(Option.some('Computer 2'))
    const answers = deviceAnswers(Option.flatMap(asked, (each) => each.instead))
    expect(answers.map((each) => [each.label, each.detail])).toEqual([
      ['Allow', 'Vivid stops using Computer 1.'],
      ['Don’t allow', 'You can allow it later in Settings.'],
    ])
  })
})

const computer = (n: number, access: DeviceAccess) => device(n, access, offline)
const allowedSince = (since: number) => DeviceAccess.cases.Allowed.make({ since })
const revokedSince = (since: number) => DeviceAccess.cases.Revoked.make({ since })

describe('deciding about a computer, shown before the server answers', () => {
  it('allows the one chosen and stops allowing the one that was', () => {
    const list = {
      devices: [computer(1, allowedSince(1)), computer(2, pending), computer(3, revokedSince(1))],
      asking: [computer(2, pending).id],
    }
    expect(allowing(computer(2, pending).id, 9)(list)).toEqual({
      asking: [],
      devices: [
        computer(1, revokedSince(9)),
        computer(2, allowedSince(9)),
        // A computer that was never allowed is left exactly as it stood.
        computer(3, revokedSince(1)),
      ],
    })
  })

  it('stops allowing one computer and leaves the rest', () => {
    const list = { devices: [computer(1, allowedSince(1)), computer(2, pending)], asking: [] }
    expect(stopping(computer(1, pending).id, 9)(list)).toEqual({
      asking: [],
      devices: [computer(1, revokedSince(9)), computer(2, pending)],
    })
  })
})
