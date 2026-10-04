import { ComputerScreen, ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import { Option } from 'effect'
import { Hand, Monitor } from 'lucide-react'
import { useReducer, useSyncExternalStore } from 'react'
import { live, useLiveValue } from '../../data/live'
import { panel } from '../../data/panel'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { Glass, hold, Viewer, type Heard, type Resolution } from '../Computer'

/** Whether the small picture has a frame on it yet; until it has, the wallpaper says "connecting". */
const seenAfter = (_seen: boolean, heard: Heard) => heard === 'opened'

/**
 * The small picture's box is one size whatever the machine's screen is, so the row in the Thread
 * does not move when the screen arrives; the screen client fits the machine's shape inside it.
 * The shape the stream reports is therefore heard and not used here.
 */
const anyResolution = (_resolution: Resolution) => undefined

/**
 * Vivid's computer, small, in the Thread, while Vivid is using it. The pattern is the reference's
 * "Computers" row with a live thumbnail (ChatGPT's side panel) and its "has control / Take over"
 * line under the computer tab: here both sit in one row in the conversation, because that is
 * where the Person is looking while Vivid works.
 *
 * The picture is the same watch-only connection the panel uses, scaled down; it sends no keys and
 * no pointer. Pressing it opens the panel beside the Thread. While the panel is open the picture
 * rests, so one window does not hold two connections to one screen.
 *
 * It shows only a computer that is running or starting. One that is off, absent or not set up
 * has nothing to watch, and the step's own line already says what happened.
 */
export function Peek() {
  const state = useLiveValue(live.computer)
  const beside = useSyncExternalStore(panel.subscribe, panel.isOpen)
  if (Option.isNone(state)) return null
  const computer = state.value.computer
  const running = ComputerState.guards.Running(computer.state)
  if (!running && !ComputerState.guards.Starting(computer.state)) return null
  return (
    <div className="mt-2.5 flex w-full max-w-md animate-fade-in items-center gap-3 rounded-card bg-surface-3 p-2 pr-3 edge">
      {/* The picture is the button; what pressing it does is said in a tooltip over it. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={panel.show}
              aria-label="Open Vivid’s computer beside the thread"
              // 6px inside an 8px pad on a card radius: the picture's corners follow the card's.
              className="relative aspect-16/10 w-32 shrink-0 cursor-pointer overflow-hidden rounded-control picture-edge transition-press duration-(--dur-fast) desktop-wallpaper hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring active:scale-96"
            />
          }
        >
          {beside ? <Resting /> : <Picture computer={computer} />}
        </TooltipTrigger>
        <TooltipContent>Open beside the thread</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label font-title text-ink">Vivid’s computer</p>
        <p className="truncate text-meta font-meta text-ink-3" aria-live="polite">
          {standing(computer)}
        </p>
      </div>
      {running && (
        <Button
          size="sm"
          variant={computer.heldByPerson ? 'default' : 'outline'}
          onClick={() => hold(!computer.heldByPerson)}
        >
          <Hand className="size-3.5" />
          {computer.heldByPerson ? 'Hand back' : 'Take over'}
        </Button>
      )}
    </div>
  )
}

/** Who has the computer right now, in the reference's words. */
const standing = (computer: ComputerRecord) => {
  if (!ComputerState.guards.Running(computer.state)) return 'Starting up…'
  return computer.heldByPerson ? 'You have control' : 'Vivid has control'
}

/** The wallpaper with a screen on it: what the picture is while there is no live frame to show. */
function Resting() {
  return (
    <span className="absolute inset-0 flex items-center justify-center text-ink-on-color">
      <Monitor className="size-5" strokeWidth={1.6} />
    </span>
  )
}

/** The live screen at thumbnail size, watch-only, by whichever way this machine is watched. */
function Picture({ computer }: { computer: ComputerRecord }) {
  const [seen, hear] = useReducer(seenAfter, false)
  const state = computer.state
  if (!ComputerState.guards.Running(state)) return <Resting />
  if (ComputerScreen.guards.Viewer(state.screen)) {
    return (
      // The provider's viewer never takes the pointer here: the button under it owns the press.
      <span className="pointer-events-none absolute inset-0">
        <Viewer
          key={state.since}
          address={state.screen.address}
          expiresAt={state.screen.expiresAt}
          control={false}
        />
      </span>
    )
  }
  return (
    <span className="pointer-events-none absolute inset-0">
      {!seen && <Resting />}
      <Glass
        address={state.screen.address}
        control={false}
        onHeard={hear}
        onResolution={anyResolution}
      />
    </span>
  )
}
