import { Layer, type Redacted } from 'effect'
import * as Socket from 'effect/unstable/socket/Socket'
import { bearer } from './transport'

/**
 * How React Native opens a WebSocket. Unlike a browser's, it takes the upgrade request's headers
 * as a third argument (`react-native/Libraries/WebSocket/WebSocket.js`), which is the only way a
 * client without cookies can say who it is on a socket. The global's DOM typing describes the
 * two-argument browser form, so the third parameter is named here.
 */
type NativeWebSocket = new (
  address: string,
  protocols: Array<string>,
  options: { readonly headers: Readonly<Record<string, string>> },
) => Socket.WebSocketLike

const NativeWebSocket: NativeWebSocket = globalThis.WebSocket

/**
 * Opens the live socket as the signed-in Person: every connection, including each reconnection
 * after the network drops, carries the session's bearer token on its upgrade.
 *
 * The browser preview cannot do this. A browser's WebSocket ignores the third argument, so the
 * socket opens unauthenticated and the server answers every call with `Unauthenticated`; the
 * preview is for looking at screens, and the web app is how a browser uses Vivid.
 */
export const bearerSocket = (token: Redacted.Redacted): Layer.Layer<Socket.WebSocketConstructor> =>
  Layer.succeed(Socket.WebSocketConstructor)(
    (address) => new NativeWebSocket(address, [], { headers: bearer(token) }),
  )
