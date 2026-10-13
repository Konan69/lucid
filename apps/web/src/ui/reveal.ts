import { revealed, revealer, type Frames } from '@vivid/state'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { still } from './motion'

/**
 * A browser's frames for pacing a reply (`@vivid/state` `reveal.ts`). A hidden tab's timers and
 * frames are throttled, and a Person who asked for less motion is not shown words creeping in:
 * both get the text at once.
 */
const frames: Frames = {
  now: () => performance.now(),
  next: (step) => {
    requestAnimationFrame(step)
  },
  instant: () => document.hidden || still(),
}

/**
 * A reply's text as it is drawn: what was there when the reply first appeared at once, and what
 * arrives afterwards let out at an even pace in place of the lumps it comes in. The reveal is
 * the reply's own for as long as it is mounted; nothing runs once the text is all shown.
 * `fresh` says the reply is still being written or let out, which is when new words fade in.
 */
export const useRevealed = (text: string, streaming: boolean) => {
  const [reveal] = useState(() => revealer(frames, text.length))
  const toward = useMemo(() => reveal.toward(text.length), [reveal, text.length])
  const shown = useSyncExternalStore(toward, reveal.read, reveal.read)
  return { drawn: revealed(text, shown), fresh: streaming || shown < text.length }
}
