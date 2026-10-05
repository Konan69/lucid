import { ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import { Option } from 'effect'
import { Hand } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { live, useLiveValue } from '../../data/live'
import { panel } from '../../data/panel'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { hold, type Resolution } from '../Computer'
import { closeup, Picture, Resting } from './Picture'

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
 * no pointer. Pressing it opens the panel beside the Thread. While the panel is open, or the card
 * around Vivid is showing the screen larger (`closeup`), the picture rests, so one window does not
 * hold two connections to one screen.
 *
 * It shows only a computer that is running or starting. One that is off, absent or not set up
 * has nothing to watch, and the step's own line already says what happened.
 */
export function Peek() {
  const state = useLiveValue(live.computer)
  const beside = useSyncExternalStore(panel.subscribe, panel.isOpen)
  const larger = useSyncExternalStore(closeup.subscribe, closeup.isShowing)
  if (Option.isNone(state)) return null
  const computer = state.value.computer
  const machine = computer.state
  const running = ComputerState.guards.Running(machine)
  if (!running && !ComputerState.guards.Starting(machine)) return null
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
              className="relative aspect-16/10 w-32 shrink-0 cursor-pointer overflow-hidden rounded-control text-ink-on-color picture-edge transition-press duration-(--dur-fast) desktop-wallpaper hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring active:scale-96"
            />
          }
        >
          {/* The wallpaper with a screen on it while there is nothing live to show: the machine
              is still starting, or its screen is already on show somewhere larger. */}
          {ComputerState.guards.Running(machine) && !beside && !larger ? (
            // A new machine start has a new connection; the one on screen is not carried over.
            <Picture key={machine.since} screen={machine.screen} onResolution={anyResolution} />
          ) : (
            <Resting />
          )}
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
