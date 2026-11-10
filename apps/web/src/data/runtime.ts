import { VividRpcClient } from '@vivid/client-runtime'
import { makeLink, makeLive } from '@vivid/state'
import { Layer } from 'effect'
import * as Socket from 'effect/socket/Socket'

/**
 * The live endpoint on the origin the page came from. The app never names a server: in
 * development Vite forwards `/api`, in the desktop app the shell serves the page from the saved
 * server's origin, and on the web the server is the origin.
 */
const liveAddress = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`

/**
 * Whether the page can reach its server; the shell says so when it cannot. When the socket opens
 * again after a loss, every query that ended in a refusal is asked again (`reopen`); the
 * conversations the page follows open their next link by themselves once the socket is ready
 * (`following`, `@vivid/state`).
 */
export const link = makeLink()
// `engine` is read when the socket returns, long after this module has finished.
link.reopened(() => engine.reopen())

/**
 * The web app's client and its Atom registry. One socket for the whole app: every call and every
 * live query rides it. The browser sends the session cookie with the upgrade, so signing in or
 * out reloads the page to open a new one.
 */
export const engine = makeLive(
  VividRpcClient.layerLive({ url: liveAddress, onLink: link.heard }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  ),
)
