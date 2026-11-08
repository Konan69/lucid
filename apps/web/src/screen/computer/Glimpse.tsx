import { ComputerState } from '@vivid/contracts'
import { Option } from 'effect'
import { live, useLiveValue } from '../../data/live'
import { usePanel } from '../../data/panel'
import { holdCloseup, Picture, Resting } from './Picture'

/** The live picture does not report a shape to anyone here: the part's frame keeps its own. */
const anyResolution = () => undefined

/**
 * The Computer's screen inside a display's `Screen` part (`vendor/openui/screen.tsx`). It is the one
 * watching picture in the app (`Picture`), so it is live while the machine runs, watch-only, and
 * takes no pointer. A machine that is off or still starting, or one already on show in the panel
 * beside the Thread, is the resting glyph, as the Thread's small picture is (`Peek`). While it
 * shows it counts as the larger picture, so the small one rests and one window does not hold two
 * connections to one screen.
 */
export function Glimpse() {
  const state = useLiveValue(live.computer)
  const beside = usePanel((shown) => shown.open)
  const running = Option.filter(
    Option.map(state, (value) => value.computer.state),
    ComputerState.guards.Running,
  )
  return Option.match(beside ? Option.none() : running, {
    onNone: () => <Resting />,
    onSome: (machine) => (
      <span ref={holdCloseup} className="absolute inset-0">
        {/* A new machine start has a new connection; the one on screen is not carried over. */}
        <Picture key={machine.since} screen={machine.screen} onResolution={anyResolution} />
      </span>
    ),
  })
}
