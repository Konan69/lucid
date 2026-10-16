import { DeviceAccess, DeviceId, DevicePresence, type Device } from '@vivid/contracts'
import { describe, expect, it } from 'vitest'
import { standing } from './computers'

/** Device ids are UUIDs; these stand for a laptop and a desk computer. */
const IDS = {
  laptop: DeviceId.make('00000000-0000-4000-8000-000000000001'),
  desk: DeviceId.make('00000000-0000-4000-8000-000000000002'),
}

const computer = (which: keyof typeof IDS, access: DeviceAccess): Device => ({
  id: IDS[which],
  name: `Computer ${which}`,
  access,
  presence: DevicePresence.cases.Offline.make({}),
})

const pending = DeviceAccess.cases.Pending.make({ since: 1 })
const allowedSince = (since: number) => DeviceAccess.cases.Allowed.make({ since })

describe('how a computer stands', () => {
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
