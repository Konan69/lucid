import * as Atom from 'effect/reactivity/Atom'

/**
 * Whether the app can reach its server right now.
 *
 * - `connecting`: the socket has not opened yet and nothing has gone wrong.
 * - `open`: calls and live results are flowing.
 * - `lost`: the socket closed, or could not be opened; the client is trying again on its own.
 */
export type Link = 'connecting' | 'open' | 'lost'

/**
 * The state of one client's socket, as an atom a screen can read and a callback the transport
 * reports to (`VividRpcClient.layerLive`'s `onLink`).
 *
 * Without it, a server that could not be reached looked exactly like a slow first load: the same
 * still outline, for as long as it took. With it a screen can say that it is reconnecting, and
 * that what it shows may be behind.
 */
export function makeLink() {
  let now: Link = 'connecting'
  const hearing = new Set<(link: Link) => void>()
  const returning = new Set<() => void>()
  return {
    atom: Atom.make<Link>((get) => {
      const hear = (link: Link) => get.setSelf(link)
      hearing.add(hear)
      get.addFinalizer(() => hearing.delete(hear))
      return now
    }),
    /** Called by the transport: the socket opened, or it closed or failed to open. */
    heard: (open: boolean) => {
      const next: Link = open ? 'open' : 'lost'
      if (next === now) return
      const back = now === 'lost'
      now = next
      for (const hear of hearing) hear(next)
      if (back) for (const wake of returning) wake()
    },
    /**
     * Runs `wake` each time the socket opens again after it was lost, and returns how to stop.
     * The first opening is not a return: nothing was following anything before it.
     *
     * Whatever cut the socket (a deploy replacing the server, a network that changed, a device
     * that slept) cut every conversation stream with it. A stream left alone notices only after
     * ninety silent seconds (`@flue/sdk` 2.2.2 `STALE_STREAM_TIMEOUT_MS`); the socket notices
     * within fifteen (`@vivid/rpc` `layerLive`). So each client has its open conversations catch
     * up from here, on web, phone and desktop alike.
     */
    reopened: (wake: () => void) => {
      returning.add(wake)
      return () => {
        returning.delete(wake)
      }
    },
  }
}
