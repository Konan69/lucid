import type { InvitationId, ThreadId } from '@vivid/contracts'
import { Result, Schema } from 'effect'

/**
 * The Vivid server a phone talks to.
 *
 * The web app never names a server because it is served by one. A phone has no such origin: the
 * Person says where their Vivid is (often their own machine, by its address on the local
 * network), and every address the app calls is built from that one value here.
 */

/** A server's origin, as an `http` or `https` address with nothing after the path. */
export const ServerAddress = Schema.String.pipe(Schema.brand('ServerAddress'))
export type ServerAddress = typeof ServerAddress.Type

/** Why what the Person typed cannot be used as a server address, in a sentence for the field. */
export class ServerAddressRefused extends Schema.TaggedError<ServerAddressRefused>()(
  'ServerAddressRefused',
  { message: Schema.String },
  { title: 'Server address refused' },
) {}

const NOT_AN_ADDRESS = 'That is not an address. It looks like http://192.168.1.20:5178.'
const NOT_PLAIN =
  'Use an http or https address with no sign-in details, question mark or hash in it.'

/**
 * Reads a typed address. Anything that could carry a credential or point somewhere other than a
 * web server (`file:`, `user:pass@`, a query, a fragment) is refused instead of being cleaned up,
 * because a token is later sent to whatever this returns.
 */
export const parseServer = (text: string): Result.Result<ServerAddress, ServerAddressRefused> =>
  Result.flatMap(
    Result.try({
      try: () => new URL(text.trim()),
      catch: () => new ServerAddressRefused({ message: NOT_AN_ADDRESS }),
    }),
    (address) => {
      const web = address.protocol === 'http:' || address.protocol === 'https:'
      const plain =
        address.username === '' &&
        address.password === '' &&
        address.search === '' &&
        address.hash === ''
      return web && plain
        ? Result.succeed(ServerAddress.make(address.href.replace(/\/+$/u, '')))
        : Result.fail(new ServerAddressRefused({ message: NOT_PLAIN }))
    },
  )

/** The address as a Person reads it: without the scheme, which is noise on a small screen. */
export const serverName = (server: ServerAddress): string => server.replace(/^https?:\/\//u, '')

/** Better Auth's routes: signing in, signing out and reading the session. */
export const accountAddress = (server: ServerAddress, path: string): string =>
  `${server}/api/auth/${path}`

/** The one WebSocket every live query and every write rides. `http` becomes `ws`, `https` `wss`. */
export const liveAddress = (server: ServerAddress): string =>
  `${server.replace(/^http/u, 'ws')}/api/live`

/**
 * A Thread's conversation, reached only through the server's gateway. The gateway is what knows
 * who is speaking; there is no other route to the conversation runtime.
 */
export const threadAddress = (server: ServerAddress, id: ThreadId): string =>
  `${server}/api/vivid/${encodeURIComponent(id)}`

/** Library bytes, which travel over plain HTTP beside the socket. */
export const libraryAddress = (server: ServerAddress, path: string): string =>
  `${server}/api/library${path}`

/** The link an invited Person opens to see who invited them, and to what, before accepting. */
export const invitationAddress = (server: ServerAddress, id: InvitationId): string =>
  `${server}/invite/${encodeURIComponent(id)}`

/** Settings → Connections in the web app, where a service is authorized in a browser. */
export const connectionsAddress = (server: ServerAddress): string =>
  `${server}/?settings=connections`

/** Settings → Rules in the web app, where what Vivid must ask about first is written. */
export const rulesAddress = (server: ServerAddress): string => `${server}/?settings=rules`

/** Settings → Record in the web app: what Vivid did, and for whom. */
export const recordAddress = (server: ServerAddress): string => `${server}/?settings=record`
