import { mended, revealed, revealer, type Frames } from '@vivid/state'
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
    requestAnimationFrame(step)
  },
  instant: () => AppState.currentState !== 'active',
}

/**
 * A reply's text as it is drawn: what was there when the reply first appeared at once, and what
 * arrives afterwards let out at an even pace in place of the lumps it comes in. Nothing runs
 * once it is all shown.
 *
 * While the reply is still being written (`streaming`) or still being let out, a mark it has
 * left open is closed for it (`mended`). It is the web's `useRevealed`
 * (`apps/web/src/ui/reveal.ts`) with one difference: the web learns of less motion in its frames,
 * and a phone learns of it from a hook. A Person who asked the phone for less motion gets the
 * text as it lands. A finished reply, and one opened from history, is neither being written nor
 * let out, so it is drawn as written.
 */
export const useRevealed = (text: string, streaming: boolean) => {
  const still = useReducedMotion()
  const [reveal] = useState(() => revealer(frames, text.length))
  const toward = useMemo(() => reveal.toward(text.length), [reveal, text.length])
  const shown = useSyncExternalStore(toward, reveal.read, reveal.read)
  if (still) return text
  const drawn = revealed(text, shown)
  // Half a bold word must not show its stars while the rest of it is on its way.
  return streaming || shown < text.length ? mended(drawn) : drawn
}
