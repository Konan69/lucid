import { faceBeat, faceStill, type FaceMood, type FaceState } from '@vivid/marks'
import { Option } from 'effect'
import { create } from 'zustand'
import { still } from '../ui/motion'

/**
 * The clock behind Vivid's living face.
 *
 * `@vivid/marks` says which look each state holds and for how long (`faceBeat`); this runs it. A
 * state has one timeline for the whole app, so every face showing that state shows the same look
 * at the same moment: there is one Vivid, and its face in the bar and its face beside a reply
 * must not blink out of step. A timeline starts at its opening pose when the first face begins
 * watching it and stops when the last one leaves, so a state nobody shows costs nothing.
 *
 * Between beats nothing runs: one timer per watched state, set for the length of the hold. While
 * the page is hidden no timer is set at all, and the timeline goes on from where it was when the
 * page is looked at again. A Person who asked for less motion gets each state's first look, held.
 */

interface Timeline {
  position: number
  look: FaceMood
  /** The timer that ends the beat on show. A hidden page and a held look have none. */
  timer: Option.Option<Timer>
  readonly watchers: Set<() => void>
}

type Timer = ReturnType<typeof setTimeout>

const timelines = new Map<FaceState, Timeline>()

/** Shows the beat the timeline is at, and sets the timer that ends it. */
function play(state: FaceState, timeline: Timeline) {
  const beat = faceBeat(state, timeline.position, Math.random)
  if (timeline.look !== beat.mood) {
    timeline.look = beat.mood
    for (const watcher of timeline.watchers) watcher()
  }
  // Hidden: hold this look. `visibilitychange` below picks the timeline up again.
  if (document.hidden) {
    timeline.timer = Option.none()
    return
  }
  timeline.timer = Option.some(
    setTimeout(() => {
      timeline.position += 1
      play(state, timeline)
    }, beat.holdMs),
  )
}

/** Begins a state's timeline for its first watcher, or adds a watcher to the one running. */
const watch = (state: FaceState) => (watcher: () => void) => {
  const running = timelines.get(state)
  if (running === undefined) {
    const timeline: Timeline = {
      position: 0,
      look: faceStill(state),
      timer: Option.none(),
      watchers: new Set([watcher]),
    }
    timelines.set(state, timeline)
    if (!still()) play(state, timeline)
  } else {
    running.watchers.add(watcher)
  }
  return () => {
    const timeline = timelines.get(state)
    if (timeline === undefined) return
    timeline.watchers.delete(watcher)
    if (timeline.watchers.size > 0) return
    Option.map(timeline.timer, clearTimeout)
    timelines.delete(state)
  }
}

// A page that is looked at again goes on with every timeline it had stopped.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || still()) return
  for (const [state, timeline] of timelines) {
    if (Option.isNone(timeline.timer)) play(state, timeline)
  }
})

export const life = {
  /**
   * One subscribe function per state, each made once: `useSyncExternalStore` subscribes again
   * whenever it is handed a new function, and that would restart the timeline on every render.
   */
  watch: {
    idle: watch('idle'),
    listening: watch('listening'),
    thinking: watch('thinking'),
    working: watch('working'),
    waiting: watch('waiting'),
    done: watch('done'),
    failed: watch('failed'),
  } satisfies Record<FaceState, ReturnType<typeof watch>>,
  /** The look a state has right now: its timeline's, or its first when nothing is watching. */
  look: (state: FaceState): FaceMood => {
    const timeline = timelines.get(state)
    return timeline === undefined ? faceStill(state) : timeline.look
  },
}

/**
 * How long after the last keystroke the Person still counts as writing. It is the least time the
 * reference holds its listening pose (`HOLD_MS.listening[0]`), so the face leans in once for a
 * sentence and does not bob between words.
 */
const WRITING_FOR_MS = 2800

/**
 * Whether the Person is writing to Vivid right now, for the face that listens. The composer says
 * so on every change to its field; the store changes only at the two edges, starting and
 * stopping, so typing a sentence renders nothing but its first key.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * The timelines above are not one: a timeline runs for exactly as long as a face is subscribed
 * to it, and that lifetime is what `useSyncExternalStore`'s subscribe function carries.
 */
export const useWriting = create(() => ({ writing: false }))

/** The timer that ends the writing. It is the clock behind the store, not something drawn. */
let writingUntil: Option.Option<Timer> = Option.none()

export const writing = {
  /** A key was pressed in the composer. */
  heard: () => {
    Option.map(writingUntil, clearTimeout)
    writingUntil = Option.some(
      setTimeout(() => {
        writingUntil = Option.none()
        useWriting.setState({ writing: false })
      }, WRITING_FOR_MS),
    )
    useWriting.setState({ writing: true })
  },
  /** The words were sent, or the Person left: nobody is writing any more. */
  stopped: () => {
    Option.map(writingUntil, clearTimeout)
    writingUntil = Option.none()
    useWriting.setState({ writing: false })
  },
}
