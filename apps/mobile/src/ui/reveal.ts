import { revealed, revealer, type Frames } from '@vivid/state'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'

/**
 * A phone's frames for pacing a reply (`@vivid/state` `reveal.ts`). An app that is not in front
 * has nobody watching and its frames stop, so what arrived meanwhile is shown at once.
 */
const frames: Frames = {
  now: () => performance.now(),
  next: (step) => {
    const frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  },
  instant: () => AppState.currentState !== 'active',
}

/**
 * A reply's text as it is drawn: what was there when the reply first appeared at once, and what
 * arrives afterwards let out at an even pace in place of the lumps it comes in. A Person who
 * asked the phone for less motion gets the text as it lands. Nothing runs once it is all shown.
 */
export const useRevealed = (text: string): string => {
  const still = useReducedMotion()
  const [reveal] = useState(() => revealer(frames, text.length))
  const toward = useMemo(() => reveal.toward(text.length), [reveal, text.length])
  const shown = useSyncExternalStore(toward, reveal.read, reveal.read)
  return still ? text : revealed(text, shown)
}
