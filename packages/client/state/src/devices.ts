import { DeviceAccess, type Device, type DeviceId, type DeviceListResponse } from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'

/** What `WatchDevices` answers with: the Person's own computers and their durable access decisions. */
export type DeviceList = typeof DeviceListResponse.Type

/** Whether Vivid may use this computer now. */
export const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)

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

/** Pending access is the only reason a computer needs an answer, even when another is connected. */
export const deviceAsked = (list: DeviceList): Option.Option<DeviceAsked> =>
  Option.fromUndefinedOr(devicesWaiting(list)[0])

/** Every Pending personal computer stays actionable until an explicit server decision. */
export const devicesWaiting = (list: DeviceList): ReadonlyArray<DeviceWaiting> => {
  const instead = Option.fromUndefinedOr(list.devices.find(allowed))
  return Arr.sort(
    list.devices.flatMap((device) =>
      DeviceAccess.guards.Pending(device.access)
        ? [{ device, instead, since: device.access.since }]
        : [],
    ),
    newestFirst,
  )
}

/** Newest first, by when each computer began to wait. */
const newestFirst: Order.Order<DeviceWaiting> = Order.mapInput(
  Order.flip(Order.Number),
  (waiting: DeviceWaiting) => waiting.since,
)

/** A computer waiting for its answer, and since when it has waited, epoch milliseconds. */
export interface DeviceWaiting extends DeviceAsked {
  readonly since: number
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
    { label: 'Deny', detail: 'You can allow it later in Settings.', allow: false },
  ] as const
