import { DeviceAccess, DevicePresence, type Device } from '@vivid/contracts'
import { DeviceLink } from '@vivid/desktop/bridge'
import { Effect, Option } from 'effect'

/**
 * A Person's own computers: the ones the Vivid desktop app has enrolled, which Vivid may use only
 * once their Person allows it. The server keeps the list and the decision, and the list is live
 * (`live.devices`): a computer whose desktop app signs in appears, waiting, in a Settings that is
 * already open on another device. This module knows what a decision does to the list before the
 * server confirms it (`allowing`, `stopping`, `@vivid/state`), what a computer's state is called,
 * and the one thing only the desktop app can say: which of them is the computer this window is
 * running on.
 */

const bridge = 'vivid' in globalThis ? Option.some(globalThis.vivid.device) : Option.none()

/**
 * Which Device this window's computer is, when it is one. In a browser tab there is no desktop
 * app and so no such computer; in the desktop app there is none until it has enrolled.
 */
export const thisComputer: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
  if (Option.isNone(bridge)) return Option.none()
  // The desktop app's bridge answers with a Promise. A rejection is the shell itself broken, not
  // an answer this has a case for, so it is not given one.
  return here(yield* Effect.promise(() => bridge.value.get()))
}).pipe(Effect.withSpan('Computers.thisComputer'))

/** Tells the desktop app its access may have changed, so it asks the server now, not later. */
export const nudgeThisComputer: Effect.Effect<void> = Effect.gen(function* () {
  if (Option.isSome(bridge)) yield* Effect.promise(() => bridge.value.refresh())
}).pipe(Effect.withSpan('Computers.nudgeThisComputer'))

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
