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
      now = next
      for (const hear of hearing) hear(next)
    },
  }
}
