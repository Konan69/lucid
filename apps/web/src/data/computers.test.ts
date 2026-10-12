import { DeviceAccess, DeviceId, DevicePresence, type Device } from '@vivid/contracts'
import { describe, expect, it } from 'vitest'
import { allowing, standing, stopping } from './computers'

/** Device ids are UUIDs; these three stand for a laptop, a desk computer and an old one. */
const IDS = {
  laptop: DeviceId.make('00000000-0000-4000-8000-000000000001'),
  desk: DeviceId.make('00000000-0000-4000-8000-000000000002'),
  old: DeviceId.make('00000000-0000-4000-8000-000000000003'),
}

const computer = (which: keyof typeof IDS, access: DeviceAccess): Device => ({
  id: IDS[which],
  name: `Computer ${which}`,
  access,
  presence: DevicePresence.cases.Offline.make({}),
})

const pending = DeviceAccess.cases.Pending.make({ since: 1 })
const allowedSince = (since: number) => DeviceAccess.cases.Allowed.make({ since })
const revokedSince = (since: number) => DeviceAccess.cases.Revoked.make({ since })

describe('deciding about a computer, shown before the server answers', () => {
  it('allows the one chosen and stops allowing the one that was', () => {
    const list = {
      devices: [
        computer('laptop', allowedSince(1)),
        computer('desk', pending),
        computer('old', revokedSince(1)),
      ],
    }
    expect(allowing(IDS.desk, 9)(list)).toEqual({
      devices: [
        computer('laptop', revokedSince(9)),
        computer('desk', allowedSince(9)),
        // A computer that was never allowed is left exactly as it stood.
        computer('old', revokedSince(1)),
      ],
    })
  })

  it('stops allowing one computer and leaves the rest', () => {
    const list = { devices: [computer('laptop', allowedSince(1)), computer('desk', pending)] }
    expect(stopping(IDS.laptop, 9)(list)).toEqual({
      devices: [computer('laptop', revokedSince(9)), computer('desk', pending)],
    })
  })

  it('says how a computer stands: waiting, allowed, and apps only where its desktop app can do them', () => {
    const connected = (apps: boolean): Device => ({
      id: IDS.laptop,
      name: 'Computer laptop',
      access: allowedSince(1),
      presence: DevicePresence.cases.Connected.make({ ability: { pages: true, apps } }),
    })
    expect(standing(connected(true))).toBe(
      'Allowed. Vivid can use the pages and the apps on this computer. A notice shows while it works, and Esc stops it.',
    )
    // A desktop app that cannot work in apps says nothing extra.
    expect(standing(connected(false))).toBe('Allowed. Vivid can use it now.')
    expect(standing(computer('laptop', allowedSince(1)))).toBe(
      'Allowed. Open the Vivid desktop app on it to connect.',
    )
    // One that just signed in can do nothing yet, connected or not.
    expect(standing(computer('desk', pending))).toBe('Waiting for you to allow it.')
  })
})
