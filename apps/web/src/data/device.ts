import { Option } from 'effect'

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
