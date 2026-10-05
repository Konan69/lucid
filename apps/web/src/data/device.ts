import { PairingClient } from '@vivid/contracts/auth'
import { Option, Schema } from 'effect'

/**
 * What to call a device from the way it introduced itself (its user-agent), in the words a Person
 * would use to recognise it: "Chrome on Mac", "Vivid on iPhone". A sign-in is listed so that it
 * can be recognised and, if it is not theirs any more, signed out; a raw user-agent string does
 * neither. Anything unrecognised is still listed, as a device.
 */

const APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Electron\//u, 'Vivid desktop app'],
  [/okhttp|Expo|CFNetwork|Darwin\//u, 'Vivid'],
  [/Edg\//u, 'Edge'],
  [/OPR\//u, 'Opera'],
  [/Firefox\//u, 'Firefox'],
  [/Chrome\//u, 'Chrome'],
  [/Safari\//u, 'Safari'],
]

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/u, 'iPhone'],
  [/iPad/u, 'iPad'],
  [/Android|okhttp/u, 'Android'],
  [/CFNetwork|Darwin\//u, 'iPhone'],
  [/Mac OS X|Macintosh/u, 'Mac'],
  [/Windows/u, 'Windows'],
  [/Linux|X11/u, 'Linux'],
]

/** The first name whose pattern the user-agent matches. Order is the tiebreak: Edge before Chrome. */
const named = (table: ReadonlyArray<readonly [RegExp, string]>, agent: string) =>
  Option.map(
    Option.fromUndefinedOr(table.find(([pattern]) => pattern.test(agent))),
    ([, name]) => name,
  )

export const deviceName = (agent: Option.Option<string>): string =>
  Option.match(agent, {
    onNone: () => 'A device',
    onSome: (said) => {
      const app = named(APPS, said)
      const system = named(SYSTEMS, said)
      if (Option.isSome(app) && Option.isSome(system)) return `${app.value} on ${system.value}`
      return Option.getOrElse(
        Option.orElse(app, () => system),
        () => 'A device',
      )
    },
  })

/**
 * What to call the app behind a sign-in request, on the page where a Person decides whether to
 * approve it. It comes from the name the app gave the server when it asked for its code.
 *
 * That name is a label, not proof: anything that can reach the server can give one of Vivid's
 * names. So the words say what kind of app asked ("A Vivid phone app"), never whose it is or
 * that it is the Person's own; what proves that is the code matching the one on their device,
 * which the page says beside this. A request with a name this app has no words for, or with
 * none, is "An app".
 *
 * Only the phone asks for a code. The desktop app signs in with Google through the system browser
 * and never comes to this page (`signin.ts`).
 */
const ASKERS = {
  'vivid-mobile': 'A Vivid phone app',
} as const satisfies Record<PairingClient, string>

const decodeClient = Schema.decodeUnknownOption(PairingClient)

export const askerName = (client: Option.Option<string>): string =>
  Option.match(Option.flatMap(client, decodeClient), {
    onNone: () => 'An app',
    onSome: (known) => ASKERS[known],
  })

/**
 * A code the way the server reads it: letters and digits only, in capitals. A Person types it as
 * they read it, with a dash or in lower case, and the server ignores both (`normalizeUserCode` in
 * better-auth 1.7.5 `dist/plugins/device-authorization/routes.mjs`).
 */
export const plainCode = (typed: string): string =>
  typed.replace(/[^a-zA-Z0-9]/gu, '').toUpperCase()
