import Constants from 'expo-constants'
import { Option, Result, Schema } from 'effect'
import { parseServer, type ServerAddress } from './server'

/**
 * Where this build's Vivid is, read once from the Expo config's `extra.server`.
 *
 * A Person is never asked for an address. A build is made for one Vivid, and the address is
 * given to the build from outside (`app.config.ts` reads it from the environment), never written
 * into the source or `app.json`. It is input like any other: decoded here, and held to the same
 * strict reading (`parseServer`) as an address a developer types, because a session token is
 * later sent to it.
 *
 * None means the build was given no address, or one that does not read as a server. A
 * development build then offers a developer-only field; a release build says plainly that it
 * was not set up (`screen/Door.tsx`).
 */
const Configured = Schema.Struct({ extra: Schema.Struct({ server: Schema.String }) })
const decodeConfigured = Schema.decodeUnknownOption(Configured)

export const origin: Option.Option<ServerAddress> = Option.flatMap(
  decodeConfigured(Constants.expoConfig),
  (config) => Result.getSuccess(parseServer(config.extra.server)),
)
