import { RunState, type Run } from '@vivid/contracts'
import { faceState, type FaceMood, type FaceSignals, type FaceState } from '@vivid/marks'
import { useState, useSyncExternalStore } from 'react'
import { life, writing } from '../data/life'
import { cn } from './cn'
import { Face } from './Face'

/**
 * Vivid's face, alive: it holds the look of what Vivid is doing, and moves to the next look of
 * that state when its hold is up (`@vivid/marks` `life.ts` has the states; `data/life.ts` runs
 * the clock). It draws the ordinary `Face` and only chooses its `mood`, so the face's colour,
 * outline and name stay the one live appearance.
 *
 * Use it where Vivid is present: the bar of a Thread, the reply it is making, the sidebar. A
 * face that is a record (an older reply) or a sample (a swatch) stays a plain `Face`.
 */
export function Alive({
  state,
  size,
  className,
}: {
  state: FaceState
  size: number
  className?: string
}) {
  // `motion-face` eases the lean from one pose to the next; the eyes change at once.
  return <Face mood={useLook(state)} size={size} className={cn('motion-face', className)} />
}

/** The look a state has right now. Every face watching the same state gets the same one. */
export const useLook = (state: FaceState): FaceMood =>
  useSyncExternalStore(life.watch[state], () => life.look(state))

/** What a screen knows about Vivid in one Thread; the rest of `FaceSignals` is found out here. */
type Known = Pick<FaceSignals, 'answering' | 'usingTool' | 'failed' | 'needsPerson'>

/**
 * The state Vivid's face is in for one Thread, from what the Thread knows plus the two things
 * only this page knows: that the Person is writing (`data/life.ts` `writing`), and that Vivid
 * finished an answer while they were here.
 *
 * "Finished" is an edge, not a fact about the Thread: opening a Thread that was answered
 * yesterday is not Vivid finishing. So it is remembered from one render to the next, set when
 * answering stops and cleared when it starts again. Adjusting state while rendering is React's
 * own way to follow a prop without an effect.
 */
export function useFaceState(known: Known): FaceState {
  const personWriting = useSyncExternalStore(writing.subscribe, writing.now)
  const [was, setWas] = useState(known.answering)
  const [finished, setFinished] = useState(false)
  if (was !== known.answering) {
    setWas(known.answering)
    setFinished(!known.answering)
  }
  return faceState({ ...known, personWriting, finished })
}

/** Whether a Run ended without an answer: it failed, or the server lost track of it. */
export const ranBadly = (run: Run) =>
  RunState.match(run.state, {
    Working: () => false,
    Completed: () => false,
    Stopped: () => false,
    Failed: () => true,
    Unknown: () => true,
  })
