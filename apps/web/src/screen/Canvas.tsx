import { ArrowUp, Mic, Paperclip } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { PhoneScreen } from '../call/phone'
import { phoneCall, teammate } from '../call/script'
import { VoicePhase, type VoiceControls, type VoiceSnapshot } from '../call/voice'
import { cn } from '../ui/cn'
import { VoiceCard } from './Call'
import { PhoneView } from './Phone'

/**
 * `/canvas`: every screen of the voice demo at rest, side by side, for design review. Frames get
 * fixed snapshots instead of live calls, so nothing here touches the microphone or Vapi.
 */

/** A voice card's controls frozen on one snapshot. */
const still = (snapshot: Partial<VoiceSnapshot> & Pick<VoiceSnapshot, 'phase'>): VoiceControls => {
  const frozen: VoiceSnapshot = {
    captions: [],
    live: '',
    beat: 7,
    muted: false,
    elapsed: 42,
    ...snapshot,
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => frozen,
    toggleMute: () => undefined,
    hangUp: () => undefined,
    loudness: () => 0.25,
  }
}

const vivid = (text: string) => ({ speaker: 'Vivid' as const, text })

const phoneFrames: ReadonlyArray<{ id: string; title: string; screen: PhoneScreen }> = [
  { id: 'phone-asleep', title: '1 · Before the demo', screen: PhoneScreen.Asleep() },
  { id: 'phone-waiting', title: '2 · Waiting for Vivid', screen: PhoneScreen.Waiting() },
  {
    id: 'phone-incoming',
    title: '3 · Vivid calls the teammate',
    screen: PhoneScreen.Incoming({ call: phoneCall(teammate) }),
  },
  {
    id: 'phone-talking',
    title: '4 · On the call',
    screen: PhoneScreen.Talking({
      voice: still({
        phase: VoicePhase.cases.Speaking.make({}),
        live: phoneCall(teammate).opening,
        beat: 11,
      }),
    }),
  },
  {
    id: 'phone-ended',
    title: '5 · Call over',
    screen: PhoneScreen.Talking({
      voice: still({
        phase: VoicePhase.cases.Ended.make({ failure: null }),
        captions: [vivid('Great — I’ll pass it on. Talk soon.')],
      }),
    }),
  },
]

const laptopFrames: ReadonlyArray<{
  id: string
  title: string
  voice: VoiceControls
  ended: string
}> = [
  {
    id: 'laptop-connecting',
    title: 'A · Connecting',
    voice: still({ phase: VoicePhase.cases.Connecting.make({}) }),
    ended: '',
  },
  {
    id: 'laptop-listening',
    title: 'B · You talk',
    voice: still({
      phase: VoicePhase.cases.Listening.make({}),
      live: 'Check my messages.',
      beat: 3,
    }),
    ended: '',
  },
  {
    id: 'laptop-speaking',
    title: 'C · Vivid answers',
    voice: still({
      phase: VoicePhase.cases.Speaking.make({}),
      captions: [vivid('Sent. Korex has v3 now.')],
      beat: 19,
    }),
    ended: '',
  },
  {
    id: 'laptop-ended',
    title: 'D · Vivid rings the teammate',
    voice: still({
      phase: VoicePhase.cases.Ended.make({ failure: null }),
      captions: [vivid('Talk soon.')],
    }),
    ended: 'Ringing their phone',
  },
]

/** An iPhone-sized frame (390 × 844 pt) with the Dynamic Island, for the phone screens. */
function Handset({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[844px] w-[390px] overflow-hidden rounded-[56px] bg-surface-0 smooth-shadow-xs ring-line">
      <span className="absolute top-3 left-1/2 z-10 h-[34px] w-[124px] -translate-x-1/2 rounded-full bg-black" />
      <div className="h-full">{children}</div>
    </div>
  )
}

/** A slice of the Thread's composer, so the laptop card is seen where it floats. */
function Composer({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-[560px] flex-col items-end gap-3 rounded-[28px] bg-surface-0 p-6 ring-line">
      {children}
      <div className="w-full rounded-composer bg-surface-3 shadow-composer">
        <p className="px-5 pt-4 pb-2 text-body text-ink-4">Message Vivid</p>
        <div className="flex items-center gap-1 px-3 pb-3 text-ink-3">
          <Paperclip className="m-2 size-4" />
          <span className="flex-1" />
          <Mic className="m-2 size-4" />
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-ink-on-accent opacity-40">
            <ArrowUp className="size-4" />
          </span>
        </div>
      </div>
    </div>
  )
}

/** Where a frame sits on the board, in board pixels at zoom 1. */
interface Placed {
  readonly id: string
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly body: ReactNode
}

const LAPTOP = { width: 560, height: 380 }
const PHONE = { width: 390, height: 844 }
const GAP = 80
const PHONE_ROW_Y = LAPTOP.height + 160

/**
 * The board's layout: laptop states along the top row, phone screens below, left to right in
 * the order they happen. Fixed coordinates are what let a `?screen=` link fly to a frame.
 */
const placed: ReadonlyArray<Placed> = [
  ...laptopFrames.map((frame, index) => ({
    id: frame.id,
    title: frame.title,
    x: index * (LAPTOP.width + GAP),
    y: 0,
    ...LAPTOP,
    body: (
      <Composer>
        <VoiceCard voice={frame.voice} ended={frame.ended} onClose={() => undefined} />
      </Composer>
    ),
  })),
  ...phoneFrames.map((frame, index) => ({
    id: frame.id,
    title: frame.title,
    x: index * (PHONE.width + GAP),
    y: PHONE_ROW_Y,
    ...PHONE,
    body: (
      <Handset>
        <PhoneView
          screen={frame.screen}
          onArm={() => undefined}
          onAnswer={() => undefined}
          onIdle={() => undefined}
        />
      </Handset>
    ),
  })),
]

/** Pan offset (screen px) and zoom of the board. */
interface View {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2

/** Centre one frame in the window, zoomed so it fits with room around it. */
const viewOf = (frame: Placed): View => {
  const zoom = Math.min(1, (innerHeight - 160) / frame.height, (innerWidth - 80) / frame.width)
  return {
    x: innerWidth / 2 - (frame.x + frame.width / 2) * zoom,
    y: (innerHeight + 60) / 2 - (frame.y + frame.height / 2) * zoom,
    zoom,
  }
}

/** The whole board, zoomed out so every frame is in view. */
const overview = (): View => {
  const width = Math.max(...placed.map((frame) => frame.x + frame.width))
  const height = Math.max(...placed.map((frame) => frame.y + frame.height))
  const zoom = Math.min(1, (innerWidth - 80) / width, (innerHeight - 140) / height)
  return { x: 40, y: 110, zoom }
}

const initialView = () => {
  const focus = new URLSearchParams(location.search).get('screen')
  const frame = placed.find((item) => item.id === focus)
  return frame === undefined ? overview() : viewOf(frame)
}

/**
 * Wheel handling is attached natively (not through React's passive `onWheel`) so it can cancel
 * the browser's own page zoom on Ctrl/⌘ + wheel. Plain wheel pans; Ctrl/⌘ + wheel zooms around
 * the cursor, which is also what a trackpad pinch sends.
 */
const attachWheel = (setView: (update: (view: View) => View) => void) => (node: HTMLElement) => {
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (!(event.ctrlKey || event.metaKey)) {
      setView((view) => ({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY }))
      return
    }
    setView((view) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * Math.exp(-event.deltaY / 300)))
      const scale = zoom / view.zoom
      return {
        zoom,
        x: event.clientX - (event.clientX - view.x) * scale,
        y: event.clientY - (event.clientY - view.y) * scale,
      }
    })
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  return () => node.removeEventListener('wheel', onWheel)
}

export function Canvas() {
  const [view, setView] = useState(initialView)
  const [focused, setFocused] = useState(() => new URLSearchParams(location.search).get('screen'))
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [wheelRef] = useState(() => attachWheel(setView))

  /** Fly to a frame and keep its link in the address bar, so it can be shared. */
  const go = (frame: Placed) => {
    history.replaceState(null, '', `?screen=${frame.id}`)
    setFocused(frame.id)
    setView(viewOf(frame))
  }
  const showAll = () => {
    history.replaceState(null, '', location.pathname)
    setFocused(null)
    setView(overview())
  }

  return (
    <main
      ref={wheelRef}
      className={cn(
        'fixed inset-0 touch-none overflow-hidden bg-surface-2 select-none',
        drag === null ? 'cursor-grab' : 'cursor-grabbing',
      )}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-chrome]') !== null)
          return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDrag({ x: event.clientX - view.x, y: event.clientY - view.y })
      }}
      onPointerMove={(event) => {
        if (drag === null) return
        setView((current) => ({ ...current, x: event.clientX - drag.x, y: event.clientY - drag.y }))
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {placed.map((frame) => (
          <figure
            key={frame.id}
            className="absolute"
            style={{ left: frame.x, top: frame.y, width: frame.width }}
          >
            <figcaption className="absolute -top-8 left-0">
              <a
                data-chrome
                href={`?screen=${frame.id}`}
                onClick={(event) => {
                  event.preventDefault()
                  go(frame)
                }}
                className={cn(
                  'cursor-pointer text-label font-title hover:underline',
                  focused === frame.id ? 'text-accent' : 'text-ink-3 hover:text-ink',
                )}
              >
                {frame.title}
              </a>
            </figcaption>
            {frame.body}
          </figure>
        ))}
      </div>

      <header
        data-chrome
        className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-surface-2/90 px-5 py-3 backdrop-blur-sm hairline-b"
      >
        <h1 className="mr-2 text-label font-title text-ink">Voice demo</h1>
        <button
          onClick={showAll}
          className={cn(
            'cursor-pointer rounded-full px-3 py-1 text-meta ring-line hover:bg-wash-hover',
            focused === null ? 'bg-accent-soft text-ink' : 'bg-surface-1 text-ink-2',
          )}
        >
          All
        </button>
        {placed.map((frame) => (
          <button
            key={frame.id}
            onClick={() => go(frame)}
            className={cn(
              'cursor-pointer rounded-full px-3 py-1 text-meta ring-line hover:bg-wash-hover hover:text-ink',
              focused === frame.id ? 'bg-accent-soft text-ink' : 'bg-surface-1 text-ink-2',
            )}
          >
            {frame.id}
          </button>
        ))}
        <span className="ml-auto text-meta text-ink-4">
          Drag to pan · scroll to move · Ctrl/⌘ + scroll to zoom · {Math.round(view.zoom * 100)}%
        </span>
      </header>
    </main>
  )
}
