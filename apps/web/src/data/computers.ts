import {
  DeviceAccess,
  DevicePresence,
  type Device,
  type DeviceId,
  type DeviceListResponse,
} from '@vivid/contracts'
import { DeviceLink } from '@vivid/desktop/bridge'
import { Option } from 'effect'

/**
 * A Person's own computers: the ones the Vivid desktop app has enrolled, which Vivid may use only
 * once their Person allows it. The server keeps the list and the decision, and the list is live
 * (`live.devices`): a computer whose desktop app signs in appears, waiting, in a Settings that is
 * already open on another device. This module knows what a decision does to the list before the
 * server confirms it, what a computer's state is called, and the one thing only the desktop app
 * can say: which of them is the computer this window is running on.
 */

const bridge = 'vivid' in globalThis ? Option.some(globalThis.vivid.device) : Option.none()

export type DeviceList = typeof DeviceListResponse.Type

/** One computer with its access changed. Every field is named, so none is dropped unseen. */
const withAccess = (device: Device, access: DeviceAccess): Device => ({
  id: device.id,
  name: device.name,
  access,
  presence: device.presence,
})

/**
 * What the list looks like once a computer is allowed, for showing the press at once: that one
 * is allowed, and any other that was is not, because Vivid acts on one computer at a time and
 * the server stops allowing the rest in the same step.
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

/** What the list looks like once a computer stops being allowed. */
export const stopping =
  (id: DeviceId, at: number) =>
  (current: DeviceList): DeviceList => ({
    devices: current.devices.map((device) =>
      device.id === id
        ? withAccess(device, DeviceAccess.cases.Revoked.make({ since: at }))
        : device,
    ),
  })

/**
 * Which Device this window's computer is, when it is one. In a browser tab there is no desktop
 * app and so no such computer; in the desktop app there is none until it has enrolled.
 */
export const thisComputer = async (): Promise<Option.Option<string>> => {
  if (Option.isNone(bridge)) return Option.none()
  return here(await bridge.value.get())
}

/** Tells the desktop app its access may have changed, so it asks the server now, not later. */
export const nudgeThisComputer = async (): Promise<void> => {
  if (Option.isSome(bridge)) await bridge.value.refresh()
}

const here = (link: DeviceLink): Option.Option<string> =>
  DeviceLink.match(link, {
    SignedOut: () => Option.none(),
    Unreachable: () => Option.none(),
    Waiting: ({ device }) => Option.some(device),
    Linked: ({ device }) => Option.some(device),
    Revoked: ({ device }) => Option.some(device),
  })

/**
 * What an allowed computer can be used for right now. Allowing a computer is the whole
 * permission: where its desktop app can work in apps (`ability.apps`, Windows with Vivid's
 * helper), the row says what that now means and how to stop it. Where it cannot, nothing is
 * added: the Person did not ask what the app lacks.
 */
const reach = (presence: DevicePresence): string =>
  DevicePresence.match(presence, {
    Offline: () => 'Allowed. Open the Vivid desktop app on it to connect.',
    Connected: ({ ability }) =>
      ability.apps
        ? 'Allowed. Vivid can use the pages and the apps on this computer. A notice shows while it works, and Esc stops it.'
        : 'Allowed. Vivid can use it now.',
  })

/** What one computer's state means, in the words its row says. */
export const standing = (device: Device): string =>
  DeviceAccess.match(device.access, {
    Pending: () => 'Waiting for you to allow it.',
    Revoked: () => 'Not allowed.',
    Allowed: () => reach(device.presence),
  })

/** Whether Vivid may use this computer, which decides the one action its row offers. */
export const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)
