import { DeviceAccess, type Device, type DeviceListResponse } from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'

/** What `WatchDevices` answers with: the Person's own computers and their durable access decisions. */
export type DeviceList = typeof DeviceListResponse.Type

/** Whether Vivid may use this computer now. */
const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)

/**
 * The one computer Vivid asks about: the newest Pending one. A desktop app that is installed again
 * enrols as a new computer, so one PC can leave several Pending rows behind (one account held
 * two from 5 and 13 October 2026 beside the allowed one); asking about each drew two prompts.
 * The older ones stay Pending and are answered in Settings → Devices, never prompted.
 */
export const deviceWaiting = (list: DeviceList): Option.Option<DeviceWaiting> => {
  const instead = Option.fromUndefinedOr(list.devices.find(allowed))
  return Arr.head(
    Arr.sort(
      list.devices.flatMap((device) =>
        DeviceAccess.guards.Pending(device.access)
          ? [{ device, instead, since: device.access.since }]
          : [],
      ),
      newestFirst,
    ),
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

/**
 * The question every surface asks. A computer's name is its host name, which is often the Person's
 * own name, so the question names the device by what it is and the card's head line
 * carries the host name.
 */
export const DEVICE_QUESTION = 'Let Vivid use your device?'

/**
 * The two answers, in the order they are drawn, each with its second line. Allowing says what
 * else changes when another computer was allowed; not allowing says where to change it later.
 */
export const deviceAnswers = (asking: Device, instead: Option.Option<Device>) =>
  [
    {
      label: 'Allow',
      detail: Option.match(instead, {
        onNone: () => 'A notice shows on it while Vivid works there.',
        // An install made again on one PC carries the same host name as the one it replaces.
        onSome: (other) =>
          other.name === asking.name
            ? `Vivid stops using the earlier install on ${other.name}.`
            : `Vivid stops using ${other.name}.`,
      }),
      allow: true,
    },
    { label: 'Deny', detail: 'You can allow it later in Settings.', allow: false },
  ] as const
