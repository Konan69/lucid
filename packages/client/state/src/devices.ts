import { DeviceAccess, type Device, type DeviceListResponse } from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'

/** What `WatchDevices` answers with: the Person's own computers and their durable access decisions. */
export type DeviceList = typeof DeviceListResponse.Type

/** Whether Vivid may use this computer now. */
export const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)

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
export interface DeviceWaiting {
  readonly device: Device
  readonly instead: Option.Option<Device>
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
