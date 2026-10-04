import { VividRpcClient } from '@vivid/client-runtime'
import { DeviceAccess, DevicePresence, type Device, type DeviceId } from '@vivid/contracts'
import { DeviceLink } from '@vivid/desktop/bridge'
import { Effect, Option } from 'effect'

/**
 * A Person's own computers: the ones the Vivid desktop app has enrolled, which Vivid may use only
 * once their Person allows it. The server keeps the list and the decision; this module asks for
 * it, changes it, and knows the one thing only the desktop app can say: which of them is the
 * computer this window is running on.
 */

const bridge = 'vivid' in globalThis ? Option.some(globalThis.vivid.device) : Option.none()

/** The Person's computers, oldest first, each with its access and whether it is listening. */
export const yourComputers = Effect.fn('Computers.list')(function* () {
  const client = yield* VividRpcClient
  return (yield* client.ListDevices()).devices
})

/** Lets Vivid use this computer and, in the same step, no other computer of this Person. */
export const allowComputer = Effect.fn('Computers.allow')(function* (id: DeviceId) {
  const client = yield* VividRpcClient
  return (yield* client.AllowDevice({ id })).device
})

/** Takes access away. The computer's link ends at once. */
export const stopAllowingComputer = Effect.fn('Computers.revoke')(function* (id: DeviceId) {
  const client = yield* VividRpcClient
  return (yield* client.RevokeDevice({ id })).device
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

/** What one computer's state means, in the words its row says. */
export const standing = (device: Device): string =>
  DeviceAccess.match(device.access, {
    Pending: () => 'Waiting for you to allow it.',
    Revoked: () => 'Not allowed.',
    Allowed: () =>
      DevicePresence.guards.Connected(device.presence)
        ? 'Allowed. Vivid can use it now.'
        : 'Allowed. Open the Vivid desktop app on it to connect.',
  })

/** Whether Vivid may use this computer, which decides the one action its row offers. */
export const allowed = (device: Device): boolean => DeviceAccess.guards.Allowed(device.access)
