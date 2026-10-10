import { ComputerScreen } from '@vivid/contracts'
import { Monitor } from 'lucide-react'
import { useReducer } from 'react'
import { create } from 'zustand'
import { Glass, sightAfter, Viewer, type Resolution } from '../Computer'

/**
 * Whether a larger picture of the screen is showing in this window: the one in the card around
 * Vivid (`thread/Screen.tsx`). The small picture in the Thread (`Peek`) rests while it is, for
 * the reason it rests while the panel is open: one window does not hold two connections to one
 * screen. It is a count and not a flag so a card that closes as another opens cannot leave the
 * small picture resting with nothing larger on show.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 */
export const useCloseup = create(() => ({ showing: 0 }))

const count = (by: number) => useCloseup.setState((was) => ({ showing: was.showing + by }))

/**
 * The ref of the element that holds the larger picture: it is counted for exactly as long as the
 * element is in the document, because React calls the returned cleanup when it leaves.
 */
export const holdCloseup = (element: HTMLElement | null) => {
  if (element === null) return undefined
  count(1)
  return () => count(-1)
}

/**
 * A screen glyph in the middle of whatever holds it: what a picture of the machine is while there
 * is no live frame to show (Grok Bot desktop app, Computer tab with the machine off, screenshots
 * of 5 Oct 2026). It takes its colour from its holder, so it reads on the dark desk and on the
 * card's flat fill alike.
 */
export function Resting() {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <Monitor aria-hidden className="size-5" strokeWidth={1.6} />
    </span>
  )
}

/** The width, in CSS pixels, a provider's viewer page is laid out at inside a picture. */
const DESK_WIDTH = 1280

/**
 * Keeps a provider's viewer page a picture of a screen and not a small web page. The page is laid
 * out at a desk's width (`DESK_WIDTH`) and scaled down to its holder, so its own controls and
 * words shrink with the desktop; loaded at the holder's 268 px they were as large as the screen
 * they sit on. The scale is the holder's width over the desk's, kept current by an observer that
 * lives exactly as long as the holder (React calls the returned cleanup). It writes one custom
 * property and nothing is rendered again for it.
 */
const fitDesk = (holder: HTMLElement | null) => {
  if (holder === null) return undefined
  const fit = () => holder.style.setProperty('--desk-fit', String(holder.clientWidth / DESK_WIDTH))
  const watching = new ResizeObserver(fit)
  watching.observe(holder)
  fit()
  return () => watching.disconnect()
}

/**
 * The live screen of a running machine, watch-only, filling whatever holds it. It is the one
 * watching picture in the app: the small one in the Thread and the one in the card around Vivid
 * are both this, so they cannot come to watch differently.
 *
 * The holder is positioned and clips; this never takes the pointer, so a press lands on the
 * holder (a button, where there is somewhere to go) and nothing a Person does here reaches the
 * machine. The machine's provider decides how its screen is watched, as in the panel
 * (`Computer.tsx`, `Screen`): its own viewer page, or the socket this server relays.
 *
 * Give it `key={since}` so a machine that was restarted gets a new connection, not the old one.
 */
export function Picture({
  screen,
  onResolution,
}: {
  screen: ComputerScreen
  /** The machine's shape as the relayed stream reports it. A viewer's is in its address. */
  onResolution: (resolution: Resolution) => void
}) {
  return ComputerScreen.match(screen, {
    Viewer: (viewer) => (
      <span ref={fitDesk} className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="absolute top-0 left-0 block picture-desk origin-top-left">
          <Viewer address={viewer.address} expiresAt={viewer.expiresAt} control={false} />
        </span>
      </span>
    ),
    Relay: (relay) => <Relayed address={relay.address} onResolution={onResolution} />,
  })
}

/**
 * The relayed screen, with the truth about whether it has arrived. Until its first frame, and
 * after a connection that never opened, the glyph stands in for it; a screen that was showing and
 * dropped is reached for again at once, by the panel's own rule (`sightAfter`). One that never
 * arrived is not dialled forever: the panel is where a Person asks for it again.
 */
function Relayed({
  address,
  onResolution,
}: {
  address: string
  onResolution: (resolution: Resolution) => void
}) {
  const [sight, hear] = useReducer(sightAfter, { seen: 'reaching', attempt: 0 })
  return (
    <span className="pointer-events-none absolute inset-0 text-ink-on-color">
      {sight.seen !== 'showing' && <Resting />}
      {sight.seen !== 'lost' && (
        // Each attempt is its own element, so its socket is opened and closed with it.
        <Glass
          key={sight.attempt}
          address={address}
          control={false}
          onHeard={hear}
          onResolution={onResolution}
        />
      )}
    </span>
  )
}
