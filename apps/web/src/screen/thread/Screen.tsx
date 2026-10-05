import { ComputerScreen, ComputerState, type Computer } from '@vivid/contracts'
import { Option } from 'effect'
import { useReducer, useSyncExternalStore, type ReactNode } from 'react'
import { live, LiveState, useLive } from '../../data/live'
import { panel } from '../../data/panel'
import { engine } from '../../data/runtime'
import { useAppearance } from '../../data/vivid'
import { cn } from '../../ui/cn'
import { Face } from '../../ui/Face'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { start, type Resolution } from '../Computer'
import { holdCloseup, Picture, Resting } from '../computer/Picture'
import { viewerResolution } from '../computer/viewer'
import { Refused } from './Rows'

/**
 * The frame every state of the picture is drawn in: landscape, as wide as the card less its
 * padding, with the reference's large corners (Grok Bot desktop app, Computer tab, screenshots of
 * 5 Oct 2026: a 576 by 360 picture, 16:10, in both the "on" and the "off" screenshot). The corners
 * are the panel radius (20), the same as the card's own, because the reference's picture is the
 * one large object in its card and not a control inside it.
 */
const FRAME = 'relative w-full overflow-hidden rounded-panel'

/** The frame while there is no machine screen in it: a flat quiet fill, as the reference's. */
const FLAT = 'bg-surface-2 text-ink-3 edge'

/**
 * What a frame that can be pressed does under the pointer and a press. Where the keyboard is, is
 * the app's own focus outline (`styles/index.css`, `:focus-visible`), drawn 2 outside the frame.
 */
const PRESSABLE = 'cursor-pointer transition-press duration-(--dur-fast) active:scale-98'

/**
 * The screen size the relayed stream last reported. The same size again is the same state, so a
 * stream that repeats itself draws nothing.
 */
const resolutionAfter = (now: Option.Option<Resolution>, next: Resolution) =>
  Option.exists(now, (was) => was.width === next.width && was.height === next.height)
    ? now
    : Option.some(next)

/**
 * The card's Computer tab, ported from the reference (Grok Bot desktop app, Computer tab,
 * screenshots of 5 Oct 2026): one thing, the machine's screen as a landscape picture with large
 * corners, and one muted line under it saying whose screen it is. No buttons, no status rows and
 * nothing drawn over the picture.
 *
 * What Vivid changes, and why:
 * - The line is "<name>’s screen" with the name this Person gave their Vivid, live.
 * - The picture is live and watch-only where the reference's may be a still: the app already has
 *   one watching picture (`computer/Picture.tsx`) and a second kind would drift from it.
 * - The picture is the one control. `onOpen` is what a press does while the machine runs: in a
 *   Thread it opens the Computer beside it; Home has no panel (the Computer is drawn only on a
 *   Thread's route), so there it is `None` and the running picture is not a button. A machine
 *   that is off is turned on by a press in both places.
 * - A machine that failed to start, or an installation with none, adds one more muted line: the
 *   reference has no such states in its screenshots, and an empty frame with no words would hide
 *   what is wrong and what to do about it.
 */
export function Screen({ onOpen }: { onOpen: Option.Option<() => void> }) {
  const computer = useLive(live.computer)
  return LiveState.$match(computer, {
    // The outline of the picture, still, where the picture will be: the card does not jump.
    Loading: () => (
      <Shot note={Option.none()}>
        <div aria-hidden className={cn(FRAME, FLAT, 'aspect-16/10')} />
      </Shot>
    ),
    Failed: () => (
      <Shot
        note={Option.some(
          <Refused onRetry={() => engine.registry.refresh(live.computer.atom)}>
            Vivid’s computer can’t be reached right now.
          </Refused>,
        )}
      >
        <div className={cn(FRAME, FLAT, 'aspect-16/10')}>
          <Resting />
        </div>
      </Shot>
    ),
    Ready: ({ value }) => <Machine computer={value.computer} onOpen={onOpen} />,
  })
}

/**
 * The picture, the line under it, and the one more line an unusual state has. The line names the
 * Person's Vivid, so it is read here once and every state says the same thing.
 */
function Shot({ note, children }: { note: Option.Option<ReactNode>; children: ReactNode }) {
  const { name } = useAppearance()
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {children}
      {/* A long name wraps and is never cut: the words after it are what the line says. */}
      <p className="max-w-full text-label font-meta text-balance wrap-break-word text-ink-3">
        {name}’s screen
      </p>
      {Option.getOrNull(note)}
    </div>
  )
}

/** One more muted line under the caption, for a state the picture cannot say by itself. */
function Note({ children }: { children: string }) {
  return (
    <p className="text-label text-pretty text-ink-3" role="status">
      {children}
    </p>
  )
}

/**
 * The picture for each state the machine can be in. Every state is a named case, so a new one
 * fails to typecheck here until it says what it shows.
 */
function Machine({ computer, onOpen }: { computer: Computer; onOpen: Option.Option<() => void> }) {
  return ComputerState.match(computer.state, {
    Running: (state) => (
      <Shot note={Option.none()}>
        <Live
          // A new machine start has a new connection; the one on screen is not carried over.
          key={state.since}
          screen={state.screen}
          onOpen={onOpen}
        />
      </Shot>
    ),
    Starting: () => (
      <Shot note={Option.none()}>
        <Waking />
      </Shot>
    ),
    Absent: () => (
      <Shot note={Option.none()}>
        <Off />
      </Shot>
    ),
    Stopped: () => (
      <Shot note={Option.none()}>
        <Off />
      </Shot>
    ),
    Failed: () => (
      <Shot note={Option.some(<Note>It did not start. Press the screen to try again.</Note>)}>
        <Off />
      </Shot>
    ),
    Unavailable: () => (
      <Shot note={Option.some(<Note>Not set up here, so Vivid works without a computer.</Note>)}>
        {/* Nothing to turn on, so nothing to press: the same frame, and not a button. */}
        <div className={cn(FRAME, FLAT, 'aspect-16/10')}>
          <Resting />
        </div>
      </Shot>
    ),
  })
}

/**
 * The reference's "off" picture (Grok Bot desktop app, Computer tab with the machine off,
 * screenshot of 5 Oct 2026): the same frame as a flat fill with a small screen glyph in its
 * centre. Here the whole frame is the button that turns the machine on (`start`, the panel's own),
 * said in a tooltip because the picture carries no words. Once the server has heard, the state
 * becomes `Starting` and the frame shows Vivid's face instead.
 */
function Off() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={start}
            aria-label="Turn on Vivid’s computer"
            className={cn(FRAME, FLAT, PRESSABLE, 'group/off aspect-16/10 hover:text-ink')}
          />
        }
      >
        {/* The fill under the pointer: a wash of the ink over the quiet fill, so it darkens in
            light and lightens in dark by the same step a row's hover does. */}
        <span className="absolute inset-0 transition-colors duration-(--dur-fast) group-hover/off:bg-wash-hover group-focus-visible/off:bg-wash-hover" />
        <Resting />
      </TooltipTrigger>
      <TooltipContent>Turn on</TooltipContent>
    </Tooltip>
  )
}

/**
 * The frame while the machine wakes: Vivid's face, thinking, where the screen will be. It is not
 * a button, because there is nothing to do but wait, and it does not move: the face's lean is the
 * whole signal, so nothing repaints for the minute or two a start can take.
 */
function Waking() {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Vivid’s computer is starting up"
      className={cn(FRAME, FLAT, 'flex aspect-16/10 items-center justify-center')}
    >
      <Face size={36} mood="thinking" />
    </div>
  )
}

/**
 * The live screen in the frame, at the machine's own proportions, watch-only
 * (`computer/Picture.tsx`).
 *
 * The screen's size comes from where the screen comes from: a provider's viewer says it in its
 * address, a relayed stream reports it once it opens. Until it is known the frame is the
 * reference's 16:10, so a relayed screen of other proportions settles once, when its first frame
 * arrives.
 *
 * In a Thread the picture rests while the Computer is open beside it, as the small picture in the
 * Thread does: one window does not hold two connections to one screen. A press still brings the
 * Computer to the front.
 */
function Live({ screen, onOpen }: { screen: ComputerScreen; onOpen: Option.Option<() => void> }) {
  const beside = useSyncExternalStore(panel.subscribe, panel.isOpen)
  const [heard, hearResolution] = useReducer(resolutionAfter, Option.none())
  const resolution = ComputerScreen.match(screen, {
    Viewer: (viewer) => viewerResolution(viewer.address),
    Relay: () => heard,
  })
  // SAFETY: React forwards these CSS custom properties to the element; `screen-glass` reads them.
  // Both are positive integers, from the viewer's address or the stream's own canvas, and with no
  // resolution yet neither is set and the class is not worn (as `Stage` in `Computer.tsx`).
  const fitStyle = {
    '--screen-w': Option.getOrUndefined(Option.map(resolution, (size) => size.width)),
    '--screen-h': Option.getOrUndefined(Option.map(resolution, (size) => size.height)),
  } as React.CSSProperties
  const frame = cn(
    FRAME,
    'text-ink-on-color picture-edge desktop-wallpaper',
    Option.isSome(resolution) ? 'screen-glass' : 'aspect-16/10',
  )
  // Home has no panel, so only a Thread's picture has one to defer to.
  const resting = Option.isSome(onOpen) && beside
  const picture = resting ? (
    <Resting />
  ) : (
    // Counted while it is in the document, so the Thread's small picture rests meanwhile.
    <span ref={holdCloseup} className="absolute inset-0">
      <Picture screen={screen} onResolution={hearResolution} />
    </span>
  )
  if (Option.isNone(onOpen)) {
    return (
      <div className={frame} style={fitStyle}>
        {picture}
      </div>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen.value}
            aria-label="Open Vivid’s computer beside the thread"
            // The picture's own hairline is an outline, which takes the place of the app's focus
            // outline, so the keyboard is shown with a ring here (as the Thread's small picture).
            className={cn(
              frame,
              PRESSABLE,
              'hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring',
            )}
            style={fitStyle}
          />
        }
      >
        {picture}
      </TooltipTrigger>
      <TooltipContent>Open beside the thread</TooltipContent>
    </Tooltip>
  )
}
