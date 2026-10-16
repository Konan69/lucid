import { DeviceAccess, DevicePresence, type Device, type DeviceId } from '@vivid/contracts'
import { Option } from 'effect'

/** What `WatchDevices` answers with: the Person's own computers. */
export interface DeviceList {
  readonly devices: ReadonlyArray<Device>
}

/** Whether Vivid may use this computer now. */
export const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)

/** Whether the computer's desktop app is listening right now. */
const connected = (device: Device): boolean => DevicePresence.guards.Connected(device.presence)

const withAccess = (device: Device, access: DeviceAccess): Device => ({
  id: device.id,
  name: device.name,
  access,
  presence: device.presence,
})

/**
 * The list as it stands once this computer is allowed, laid over the live list while the call is
 * on its way. Allowing one computer stops allowing any other in the same step on the server
 * (`apps/server/src/computers/device.ts`, `allow`), so the expectation says the same.
 */
export const allowing =
  (id: DeviceId, at: number) =>
  (current: DeviceList): DeviceList => ({
    devices: current.devices.map((device) => {
      if (device.id === id) {
        return withAccess(device, DeviceAccess.cases.Allowed.make({ since: at }))
      }
      return allowed(device)
        ? withAccess(device, DeviceAccess.cases.Revoked.make({ since: at }))
        : device
    }),
  })

/** The list as it stands once this computer is no longer allowed, or was never allowed. */
export const stopping =
  (id: DeviceId, at: number) =>
  (current: DeviceList): DeviceList => ({
    devices: current.devices.map((device) =>
      device.id === id
        ? withAccess(device, DeviceAccess.cases.Revoked.make({ since: at }))
        : device,
    ),
  })

/** The computer Vivid asks about, and the allowed one that would stop being allowed. */
export interface DeviceAsked {
  readonly device: Device
  readonly instead: Option.Option<Device>
}

/**
 * The computer Vivid asks this Person about where they already are, over the composer: one whose
 * desktop app is open and listening and which nobody has answered for yet (`Pending`).
 *
 * It is asked only while no allowed computer is listening: with one already in use there is
 * nothing Vivid is waiting on, and a second app signed in somewhere is not a reason to interrupt.
 * `instead` is the allowed computer that would stop being allowed, because Vivid uses one at a
 * time. A computer answered "Don't allow" is `Revoked` on the server, so it is not asked again on
 * any surface; it can still be allowed from Settings.
 *
 * Until 16 October 2026 the only place this was decided was Settings > Computers, where a
 * computer sat "Waiting for you to allow it" without saying so anywhere the Person looks. The
 * owner: "why is it waitong forme to allow it? and why is this so hidden".
 */
export const deviceAsked = (devices: ReadonlyArray<Device>): Option.Option<DeviceAsked> => {
  if (devices.some((device) => allowed(device) && connected(device))) return Option.none()
  return Option.map(
    Option.fromUndefinedOr(
      devices.find((device) => DeviceAccess.guards.Pending(device.access) && connected(device)),
    ),
    (device) => ({ device, instead: Option.fromUndefinedOr(devices.find(allowed)) }),
  )
}

/** The question over the composer for the computer `deviceAsked` names. */
export const deviceQuestion = (device: Device): string => `Let Vivid use ${device.name}?`

/**
 * The two answers, in the order they are drawn, each with its second line. Allowing says what
 * else changes when another computer was allowed; not allowing says where to change it later.
 */
export const deviceAnswers = (instead: Option.Option<Device>) =>
  [
    {
      label: 'Allow',
      detail: Option.match(instead, {
        onNone: () => 'A notice shows on it while Vivid works there.',
        onSome: (other) => `Vivid stops using ${other.name}.`,
      }),
      allow: true,
    },
    { label: 'Don’t allow', detail: 'You can allow it later in Settings.', allow: false },
  ] as const
